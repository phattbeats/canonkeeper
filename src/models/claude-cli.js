// A `generate` for offline runs: the Claude Code CLI in print mode, with no
// tools and our own system prompt. Node-only; the SillyTavern adapter will
// supply its own `generate` from the user's connection profile instead.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export function claudeCli({ model = 'claude-sonnet-5', bin = 'claude' } = {}) {
    return ({ system, user, maxTokens }) =>
        new Promise((resolve, reject) => {
            const args = ['-p', '--model', model, '--system-prompt', system, '--tools', '', '--output-format', 'json', '--no-session-persistence'];
            // Thinking would spend the output budget the lorebook needs.
            const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens), MAX_THINKING_TOKENS: '0' };
            // Run outside the repo, so the CLI loads no project instructions or
            // memory: the model sees only our prompt.
            const child = spawn(bin, args, { env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => (out += d));
            child.stderr.on('data', (d) => (err += d));
            child.on('error', reject);
            child.on('close', (code) => {
                let parsed;
                try {
                    parsed = JSON.parse(out);
                } catch {
                    return reject(new Error(`claude exited ${code}: ${err || out}`.slice(0, 2000)));
                }
                // The same, when the CLI reports it as an error instead.
                if (parsed.api_error === 'max_output_tokens') return resolve('');
                if (parsed.is_error || typeof parsed.result !== 'string') return reject(new Error(`claude failed: ${JSON.stringify(parsed).slice(0, 2000)}`));
                // A reply cut off at the output limit is not a reply. The CLI
                // continues it in a second iteration and `result` then holds
                // only the tail, so either sign means: hand back nothing.
                if (parsed.stop_reason === 'max_tokens' || (parsed.usage?.iterations?.length ?? 1) > 1) return resolve('');
                resolve(parsed.result);
            });
            child.stdin.end(user);
        });
}
