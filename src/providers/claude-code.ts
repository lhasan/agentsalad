/**
 * Claude Code CLI Provider — claude --print 모드를 Vercel AI SDK LanguageModel로 래핑
 *
 * Claude Code CLI의 --print 모드를 사용하여 메시지를 처리.
 * Tool calling은 Claude Code 자체 도구(Edit, Write, Bash 등)를 통해 처리.
 *
 * 요구사항:
 * - claude CLI가 PATH에 설치되어 있어야 함
 * - ANTHROPIC_API_KEY 환경변수 또는 OAuth 인증 설정
 * - apiKey 파라미터는 ANTHROPIC_API_KEY로 주입됨
 *
 * 제한사항:
 * - Vercel AI SDK의 streamText tool calling과 호환되지 않음
 *   → Claude Code 자체 도구 시스템으로 대체
 * - streaming은 stdout pipe로 처리
 */
import { type LanguageModel } from 'ai';
import { spawn } from 'child_process';
import { logger } from '../logger.js';

/** Claude Code CLI가 시스템에 설치되어 있는지 확인 */
export function isClaudeCodeAvailable(): boolean {
  try {
    const { execSync } = require('child_process');
    execSync('which claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface ClaudeCodeCallParams {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  apiKey?: string;
  maxBudgetUsd?: number;
  allowedTools?: string[];
}

/**
 * Claude Code CLI를 --print 모드로 호출하여 응답을 받는 함수.
 * Vercel AI SDK의 LanguageModel 인터페이스와 직접 호환되지 않으므로
 * service-router에서 별도 경로로 처리해야 함.
 */
export async function callClaudeCode(
  params: ClaudeCodeCallParams,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = ['--print', '--bare'];

    if (params.model) {
      args.push('--model', params.model);
    }

    if (params.systemPrompt) {
      args.push('--system-prompt', params.systemPrompt);
    }

    if (params.maxBudgetUsd) {
      args.push('--max-budget-usd', String(params.maxBudgetUsd));
    }

    if (params.allowedTools && params.allowedTools.length > 0) {
      args.push('--allowedTools', params.allowedTools.join(','));
    }

    // 프롬프트를 마지막 인자로
    args.push(params.prompt);

    const env: Record<string, string> = { ...process.env } as Record<
      string,
      string
    >;
    // API key가 있으면 설정, 없으면 환경변수도 비워서 OAuth 세션 사용
    if (params.apiKey && params.apiKey.length > 50) {
      env.ANTHROPIC_API_KEY = params.apiKey;
    } else {
      // 짧거나 빈 키는 무효 → 삭제하여 OAuth fallback
      delete env.ANTHROPIC_API_KEY;
    }

    logger.debug(
      {
        model: params.model,
        promptLen: params.prompt.length,
        hasSystemPrompt: !!params.systemPrompt,
        authMode: env.ANTHROPIC_API_KEY ? 'api-key' : 'oauth',
      },
      'Calling Claude Code CLI',
    );

    const child = spawn('claude', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000, // 5분 타임아웃
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const errMsg = stderr.trim() || `Claude Code exited with code ${code}`;
        logger.warn({ code, stderr: errMsg }, 'Claude Code CLI error');
        reject(new Error(errMsg));
      }
    });

    child.on('error', (err: Error) => {
      reject(
        new Error(
          `Failed to spawn Claude Code CLI: ${err.message}. Is 'claude' installed?`,
        ),
      );
    });
  });
}

/**
 * Claude Code CLI를 --print 모드로 호출하여 스트리밍 응답을 반환.
 * AsyncGenerator로 청크를 yield.
 */
export async function* streamClaudeCode(
  params: ClaudeCodeCallParams,
): AsyncGenerator<string> {
  const args: string[] = ['--print', '--bare'];

  if (params.model) {
    args.push('--model', params.model);
  }

  if (params.systemPrompt) {
    args.push('--system-prompt', params.systemPrompt);
  }

  if (params.maxBudgetUsd) {
    args.push('--max-budget-usd', String(params.maxBudgetUsd));
  }

  if (params.allowedTools && params.allowedTools.length > 0) {
    args.push('--allowedTools', params.allowedTools.join(','));
  }

  args.push(params.prompt);

  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  // API key가 있으면 설정, 없으면 환경변수도 비워서 OAuth 세션 사용
  if (params.apiKey && params.apiKey.length > 50) {
    env.ANTHROPIC_API_KEY = params.apiKey;
  } else {
    delete env.ANTHROPIC_API_KEY;
  }

  const child = spawn('claude', args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300_000,
  });

  let stderr = '';

  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  // stdout를 청크 단위로 yield
  const readable = child.stdout;

  try {
    for await (const chunk of readable) {
      yield (chunk as Buffer).toString();
    }
  } catch (err) {
    // 스트림 에러
  }

  // 프로세스 종료 대기
  await new Promise<void>((resolve, reject) => {
    child.on('close', (code: number | null) => {
      if (code !== 0 && code !== null) {
        const errMsg = stderr.trim() || `Claude Code exited with code ${code}`;
        logger.warn({ code, stderr: errMsg }, 'Claude Code CLI stream error');
        // 이미 일부 데이터를 yield했을 수 있으므로 reject 대신 로그만
      }
      resolve();
    });
    child.on('error', (err: Error) => {
      logger.error({ err: err.message }, 'Claude Code CLI spawn error');
      resolve(); // reject하면 이미 yield한 데이터를 잃음
    });
  });
}

/**
 * Vercel AI SDK LanguageModel 팩토리 (제한적 호환).
 *
 * Claude Code CLI는 Vercel AI SDK의 LanguageModel 인터페이스와
 * 직접 호환되지 않으므로, 이 함수 대신 streamClaudeCode()를 사용하는 것이 권장됨.
 *
 * 이 팩토리는 서비스 라우터의 프로바이더 분기에서 claude-code를
 * 식별하기 위한 마커 역할.
 */
export function createClaudeCodeModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  // Claude Code CLI는 LanguageModel 인터페이스와 호환되지 않음.
  // service-router에서 providerId === 'claude-code'일 때
  // streamChat 대신 streamClaudeCode를 직접 호출해야 함.
  throw new Error(
    'Claude Code CLI does not implement Vercel AI SDK LanguageModel interface. ' +
      'Use streamClaudeCode() directly in service-router.',
  );
}
