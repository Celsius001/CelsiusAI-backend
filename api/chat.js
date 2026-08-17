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

    const { model, prompt, messages, stream, userId } = req.body;

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

    const apiUrl = 'https://nocturne.lol/api/ai';
    const apiKey = process.env.NOCTURNE_API_KEY;
    
    let finalPrompt = prompt;
    if (!finalPrompt && messages) {
        finalPrompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    }

    const requestBody = {
        model: model, 
        prompt: finalPrompt,
        stream: stream || false
    };

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                res.write(decoder.decode(value));
            }
            return res.end();
        } else {
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error?.message || 'Failed to fetch');
            }
            return res.status(200).json(data);
        }

    } catch (error) {
        return res.status(500).json({ error: 'Error communicating with AI service' });
    }
}
