const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const model = genAI.getGenerativeModel({ model: modelName });

function selectRepresentativeScreenshots(screenshots, maxCount = 10) {
  if (screenshots.length <= maxCount) return screenshots;

  const interval = Math.floor(screenshots.length / maxCount);
  const selected = [screenshots[0]];

  for (let i = interval; i < screenshots.length - 1 && selected.length < maxCount - 1; i += interval) {
    selected.push(screenshots[i]);
  }
  selected.push(screenshots[screenshots.length - 1]);

  return selected;
}

async function analyzeScreenshots(screenshots) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const selected = selectRepresentativeScreenshots(screenshots);

  const imageParts = selected.map(s => ({
    inlineData: {
      data: s.screenshot_url.replace(/^data:image\/\w+;base64,/, ''),
      mimeType: 'image/png'
    }
  }));

  const prompt = `Analyze these ${selected.length} workplace screenshots from one workday.

Provide:
1. A 2-3 sentence summary of the work activities observed
2. Applications/tools visible with usage frequency (high/medium/low)
3. Work activity categories (coding, meetings, documentation, communication, etc.)

Be professional and factual. Focus only on work-related observations.
Do not include personal information or make productivity judgments.

Return ONLY valid JSON in this exact format:
{"summary":"...","applications":[{"name":"...","frequency":"high|medium|low"}],"activities":[{"type":"...","description":"..."}]}`;

  const result = await model.generateContent([prompt, ...imageParts]);
  const text = result.response.text();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('Gemini response:', text);
    throw new Error('Failed to parse AI response');
  }

  return JSON.parse(jsonMatch[0]);
}

module.exports = { analyzeScreenshots, selectRepresentativeScreenshots };
