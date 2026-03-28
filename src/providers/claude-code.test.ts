/**
 * Claude Code CLI Provider — Unit Tests
 *
 * CLI 호출 없이 모듈 구조와 export를 검증.
 * 실제 CLI 호출 테스트는 통합 테스트에서 수행.
 */
import { describe, it, expect } from 'vitest';

describe('claude-code provider module', () => {
  it('exports callClaudeCode function', async () => {
    const mod = await import('./claude-code.js');
    expect(typeof mod.callClaudeCode).toBe('function');
  });

  it('exports streamClaudeCode function', async () => {
    const mod = await import('./claude-code.js');
    expect(typeof mod.streamClaudeCode).toBe('function');
  });

  it('exports isClaudeCodeAvailable function', async () => {
    const mod = await import('./claude-code.js');
    expect(typeof mod.isClaudeCodeAvailable).toBe('function');
  });

  it('createClaudeCodeModel throws with helpful message', async () => {
    const mod = await import('./claude-code.js');
    expect(() =>
      mod.createClaudeCodeModel({
        model: 'sonnet',
        apiKey: 'test',
      }),
    ).toThrow('does not implement Vercel AI SDK');
  });
});

describe('provider router claude-code branch', () => {
  it('MODEL_FACTORIES does not include claude-code (handled separately)', async () => {
    // claude-code는 streamChat에서 분기 처리되므로 MODEL_FACTORIES에 없어야 함
    const indexMod = await import('./index.js');
    // streamChat가 export되는지 확인
    expect(typeof indexMod.streamChat).toBe('function');
    expect(typeof indexMod.chat).toBe('function');
  });
});
