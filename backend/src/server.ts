

import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Content, Type, Modality } from '@google/genai';

dotenv.config();

// Define custom types locally as they are specific to this application.
type BloomLevel = 'remembering' | 'understanding' | 'applying' | 'analyzing' | 'evaluating' | 'creating';

interface QuizQuestion {
  question: string;
  type: 'multiple-choice' | 'essay';
  options?: string[];
  answer?: string;
  imageUrl?: string;
  bloomLevel?: BloomLevel;
}


const app = express();
const port = process.env.PORT || 3001;

// Middleware
// Use explicit CORS configuration to prevent potential cross-origin issues.
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' })); // Increase payload size limit for file uploads

// Helper function to initialize the AI client
const getAIClient = () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        throw new Error("API_KEY is not defined in environment variables.");
    }
    return new GoogleGenAI({ apiKey });
};

// Centralized error handler
const handleError = (res: Response, error: unknown, context: string) => {
    console.error(`Error in ${context}:`, error);
    const message = error instanceof Error ? error.message : "An unknown error occurred.";
    res.status(500).json({ error: `Failed during ${context}. ${message}` });
};

// --- API Routes ---

app.get('/', (req: Request, res: Response) => {
    res.send('Lyly Assistant Backend is running!');
});

app.post('/api/chat', async (req: Request, res: Response) => {
    const { prompt, history, fileContext } = req.body;
    try {
        const ai = getAIClient();
        const chatSession = ai.chats.create({
            model: 'gemini-2.5-flash',
            config: {
                 systemInstruction: `Bạn là Lyly, một trợ lý AI chuyên gia về môn học "Nguồn điện An toàn và Môi trường" dành cho sinh viên đại học. Hãy duy trì giọng điệu chuyên nghiệp, rõ ràng và hỗ trợ. Luôn xưng hô với người dùng là "bạn" hoặc "sinh viên". Nhiệm vụ chính của bạn: 1. **Hỏi-Đáp Chuyên sâu:** Cung cấp câu trả lời chính xác. 2. **Phân tích Tài liệu:** Khi được cung cấp tài liệu, câu trả lời phải dựa *tuyệt đối* vào thông tin trong tài liệu. 3. **Tích hợp Google Search:** Đối với các câu hỏi về thông tin mới, hãy sử dụng Google Search. Luôn trích dẫn nguồn. LUÔN LUÔN trả lời bằng tiếng Việt.`,
                 tools: [{ googleSearch: {} }],
            },
            history: history || [],
        });

        let finalPrompt = prompt;
        if (fileContext) {
            finalPrompt = `Dựa vào nội dung tài liệu sau đây:\n---\nTên tệp: ${fileContext.name}\nNội dung: ${fileContext.content}\n---\nHãy trả lời câu hỏi: "${prompt}"`;
        }
        
        const geminiResponse = await chatSession.sendMessage({ message: finalPrompt });
        const responseText = geminiResponse.text;
        
        const groundingMetadata = geminiResponse.candidates?.[0]?.groundingMetadata;
        let sources = [];
        if (groundingMetadata?.groundingChunks) {
            sources = groundingMetadata.groundingChunks
                .filter(chunk => chunk.web)
                .map(chunk => ({
                    uri: chunk.web!.uri,
                    title: chunk.web!.title,
                }));
        }

        res.json({ responseText, sources });

    } catch (error) {
        handleError(res, error, "chat generation");
    }
});


app.post('/api/speech', async (req: Request, res: Response) => {
    const { text, settings } = req.body;
    const voiceMap = {
        'female-north': { voiceName: 'Kore', accent: 'giọng Hà Nội chuẩn' },
        'male-north': { voiceName: 'Puck', accent: 'giọng nam Hà Nội' },
        'female-south': { voiceName: 'Charon', accent: 'giọng Sài Gòn' },
        'male-south': { voiceName: 'Zephyr', accent: 'giọng nam Sài Gòn' },
    };
    const speedMap = { slow: 'chậm rãi', normal: 'bình thường', fast: 'nhanh' };
    
    try {
        const ai = getAIClient();
        const voiceConfig = voiceMap[settings.voice] || voiceMap['female-north'];
        const speedInstruction = speedMap[settings.speed] || speedMap['normal'];
        const prompt = `Nói một cách tự nhiên bằng ${voiceConfig.accent}, với tốc độ ${speedInstruction}: "${text}"`;

        const geminiResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text: prompt }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceConfig.voiceName } },
                },
            },
        });
        const audioBase64 = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        res.json({ audioBase64 });
    } catch (error) {
        handleError(res, error, "speech generation");
    }
});

app.post('/api/quick-replies', async (req: Request, res: Response) => {
    const { chatHistory } = req.body;
    if (!chatHistory || chatHistory.length === 0 || chatHistory[chatHistory.length - 1].role === 'user') {
        return res.json({ suggestions: [] });
    }
    try {
        const ai = getAIClient();
        const geminiResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [
                ...chatHistory,
                { role: 'user', parts: [{ text: 'Gợi ý 3 câu hỏi tiếp theo ngắn gọn.' }] }
            ],
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: { suggestions: { type: Type.ARRAY, items: { type: Type.STRING } } }
                }
            }
        });
        const parsed = JSON.parse(geminiResponse.text.trim());
        res.json({ suggestions: parsed.suggestions || [] });
    } catch (error) {
        handleError(res, error, "quick reply generation");
    }
});

app.post('/api/quiz', async (req: Request, res: Response) => {
    const { fileContent, fileName, quizType, levelCounts, advancedOptions } = req.body;
    
    const totalQuestions = Object.values(levelCounts || {}).reduce((sum: number, count) => sum + (Number(count) || 0), 0);
    
    const bloomLevelsMap: Record<string, string> = {
        remembering: 'Nhận biết', understanding: 'Thông hiểu', applying: 'Vận dụng',
        analyzing: 'Phân tích', evaluating: 'Đánh giá', creating: 'Sáng tạo',
    };
    const questionRequests = Object.entries(levelCounts)
        .filter(([, count]) => (count as number) > 0)
        .map(([level, count]) => `- ${count} câu hỏi ở cấp độ ${bloomLevelsMap[level]}`)
        .join('\n');

    const quizTypeInstruction = quizType === 'multiple-choice'
        ? 'Trắc nghiệm (4 lựa chọn, 1 đáp án đúng).'
        : "Tự luận. Mỗi câu hỏi phải đi kèm một đáp án mẫu chi tiết.";

    const prompt = `Với vai trò là một chuyên gia thiết kế chương trình học, hãy tạo một bộ câu hỏi từ tài liệu "${fileName}" được cung cấp, tuân thủ nghiêm ngặt các yêu cầu sau:

1.  **Phân bổ câu hỏi theo cấp độ tư duy Bloom:** Bạn PHẢI tạo chính xác số lượng câu hỏi cho mỗi cấp độ như sau:
${questionRequests}
    - Tổng số câu hỏi phải chính xác là ${totalQuestions}.
    - Mỗi câu hỏi được tạo ra phải được gán chính xác trường 'bloomLevel' tương ứng (ví dụ: 'remembering', 'understanding', v.v.).

2.  **Loại câu hỏi:** ${quizTypeInstruction}

3.  **Tùy chọn nội dung:**
    - ${advancedOptions.includeFormulas ? 'Bao gồm công thức toán học/lý học. Sử dụng định dạng KaTeX (ví dụ: $E=mc^2$).' : 'Không bao gồm công thức.'}
    - ${advancedOptions.includeImages ? 'Có thể đề xuất URL hình ảnh từ placeholder.com nếu phù hợp.' : 'Không bao gồm hình ảnh.'}

4.  **Ngôn ngữ:** Toàn bộ nội dung phải bằng Tiếng Việt.

5.  **Định dạng đầu ra:** Phải là một mảng JSON hợp lệ theo schema đã cung cấp.

Nội dung tài liệu:
---
${fileContent}
---`;

    try {
        const ai = getAIClient();
        const geminiResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: { questions: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
                        question: { type: Type.STRING }, type: { type: Type.STRING },
                        options: { type: Type.ARRAY, items: { type: Type.STRING } },
                        answer: { type: Type.STRING },
                        imageUrl: { type: Type.STRING },
                        bloomLevel: { type: Type.STRING },
                    }, required: ['question', 'type', 'bloomLevel'] } } } }
                }
            }
        });
        const parsed = JSON.parse(geminiResponse.text.trim());
        res.json({ questions: parsed.questions || [] });
    } catch (error) {
        handleError(res, error, "quiz generation");
    }
});

app.post('/api/image', async (req: Request, res: Response) => {
    const { text } = req.body;
    const prompt = `Tạo một hình ảnh minh họa đơn giản, theo phong cách biểu đồ hoặc ký họa cho khái niệm: "${text}"`;
    try {
        const ai = getAIClient();
        const geminiResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts: [{ text: prompt }] },
            config: { responseModalities: [Modality.IMAGE] },
        });
        const base64Image = geminiResponse.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
        if (!base64Image) throw new Error("No image data in AI response.");
        res.json({ base64Image });
    } catch (error) {
        handleError(res, error, "image generation");
    }
});

app.post('/api/explanation', async (req: Request, res: Response) => {
    const { question } = req.body as { question: QuizQuestion };

    if (question.type !== 'multiple-choice' || !question.answer || !question.options) {
        return res.json({ explanation: "Đây là câu hỏi mở hoặc thiếu thông tin, không có giải thích tự động." });
    }

    const otherOptions = question.options.filter(opt => opt !== question.answer).join('", "');

    const prompt = `Đối với câu hỏi trắc nghiệm sau đây:
Câu hỏi: "${question.question}"
Đáp án đúng: "${question.answer}"

Hãy giải thích một cách rõ ràng:
1.  Tại sao "${question.answer}" là đáp án chính xác.
2.  Tại sao các lựa chọn khác là không chính xác. Các lựa chọn khác bao gồm: "${otherOptions}".

Cấu trúc câu trả lời của bạn nên có hai phần rõ ràng cho hai điểm trên.`;
    // FIX: Correctly wrap the API call and response logic in a try-catch block
    // to handle potential errors and resolve scoping issues.
    try {
        const ai = getAIClient();
        const geminiResponse = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt });
        res.json({ explanation: geminiResponse.text });
    } catch (error) {
        handleError(res, error, "answer explanation");
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Backend server is running on http://localhost:${port}`);
});