import { kv } from '@vercel/kv';
import cors from 'cors';

function runMiddleware(req, res, fn) {
    return new Promise((resolve, reject) => {
        fn(req, res, (result) => {
            if (result instanceof Error) return reject(result);
            return resolve(result);
        });
    });
}

const corsMiddleware = cors({
    methods: ['POST', 'OPTIONS'],
    origin: '*' 
});

export default async function handler(req, res) {
    await runMiddleware(req, res, corsMiddleware);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt, messages, userId } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'Missing API Key' });
    }

    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }

    const today = new Date().toISOString().split('T')[0]; 
    const rateLimitKey = `rate_limit:${userId}:${today}`;
    
    try {
        const currentUsage = await kv.incr(rateLimitKey);
        
        if (currentUsage === 1) {
            await kv.expire(rateLimitKey, 86400); 
        }

        if (currentUsage > 60) {
            return res.status(429).json({ 
                error: 'Daily limit reached.' 
            });
        }
    } catch (error) {
        return res.status(500).json({ error: 'Internal server error' });
    }
    
    let finalPrompt = prompt;
    if (!finalPrompt && messages) {
        finalPrompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    }

    if (!finalPrompt) {
        return res.status(400).json({ error: 'Missing prompt in request body' });
    }

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: finalPrompt }] }]
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({ error: data.error?.message || 'API Error' });
        }

        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
        return res.status(200).json({ reply });

    } catch (error) {
        return res.status(500).json({ error: 'Error communicating with AI service' });
    }
}
