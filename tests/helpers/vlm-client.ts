import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';
const DEFAULT_MODEL = 'minicpm-v';
const FAST_MODEL = 'moondream';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface VLMOptions {
  model?: string;
  temperature?: number;
  timeoutMs?: number;
}

export interface VLMResponse {
  content: string;
  model: string;
  done: boolean;
  evalCount: number;
}

export function imageToBase64(imagePath: string): string {
  const absolutePath = resolve(imagePath);
  const buffer = readFileSync(absolutePath);
  return buffer.toString('base64');
}

export async function queryVLM(
  imagePath: string,
  prompt: string,
  options: VLMOptions = {},
): Promise<VLMResponse> {
  const model = options.model ?? DEFAULT_MODEL;
  const base64 = imageToBase64(imagePath);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
            images: [base64],
          },
        ],
        stream: false,
        options: {
          temperature: options.temperature ?? 0.1,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as {
      message: { content: string };
      model: string;
      done: boolean;
      eval_count: number;
    };
    return {
      content: data.message.content.trim(),
      model: data.model,
      done: data.done,
      evalCount: data.eval_count,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function analyzeScreenshot(
  imagePath: string,
  assertion: string,
): Promise<{ passed: boolean; explanation: string }> {
  const prompt = `You are a game test assistant. Analyze this screenshot and answer the following question with ONLY "YES" or "NO" followed by a brief explanation on a new line.

Question: ${assertion}

Format:
YES/NO
<brief explanation>`;
  const response = await queryVLM(imagePath, prompt);
  const lines = response.content.split('\n').filter((l) => l.trim().length > 0);
  const firstLine = lines[0]?.trim().toUpperCase() ?? '';
  return {
    passed: firstLine.startsWith('YES'),
    explanation: lines.slice(1).join('\n').trim() || response.content,
  };
}

export async function fastCheck(imagePath: string, question: string): Promise<VLMResponse> {
  return queryVLM(imagePath, question, { model: FAST_MODEL });
}

export async function isOllamaReady(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getAvailableModels(): Promise<string[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    models: Array<{ name: string }>;
  };
  return data.models.map((m) => m.name);
}
