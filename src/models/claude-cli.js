// A `generate` for offline runs: the Claude Code CLI in print mode, with no
// tools and our own system prompt. Node-only; the SillyTavern adapter will
// supply its own `generate` from the user's connection profile instead.

import { spawn } from 'node:child_process';

export function claudeCli({ model = 'claude-sonnet-5', bin = 'claude' } = {}) {
    return ({ system, user, maxTokens }) =>
        new Promise((resolve, reject) => {
            const args = ['-p', '--model', model, '--system-prompt', system, '--tools', '', '--output-format', 'json', '--no-session-persistence'];
            const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) };
            const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
                if (parsed.is_error || typeof parsed.result !== 'string') return reject(new Error(`claude failed: ${JSON.stringify(parsed).slice(0, 2000)}`));
                // A reply cut off at the output limit is not a reply; returning
                // it would hand the parser a fragment.
                if (parsed.stop_reason === 'max_tokens') return resolve('');
                resolve(parsed.result);
            });
            child.stdin.end(user);
        });
}
