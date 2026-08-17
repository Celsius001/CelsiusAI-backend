import { kv } from '@vercel/kv';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
    
    let finalPrompt = prompt;
    if (!finalPrompt && messages) {
        finalPrompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    }

    try {
        const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            
            const result = await aiModel.generateContentStream(finalPrompt);

            for await (const chunk of result.stream) {
                const text = chunk.text();
                if (text) {
                    res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
                }
            }
            
            res.write(`data: [DONE]\n\n`);
            return res.end();
        } else {
            const result = await aiModel.generateContent(finalPrompt);
            return res.status(200).json({ text: result.response.text() });
        }

    } catch (error) {
        if (!res.headersSent) {
            return res.status(500).json({ error: 'Error communicating with AI service' });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', text: '\n[Stream interrupted due to server error]' })}\n\n`);
            return res.end();
        }
    }
}
