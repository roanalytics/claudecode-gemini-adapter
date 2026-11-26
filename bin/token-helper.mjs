if (!process.env.CLAUDE_GEMINI_ADAPTER_KEY) process.exit(1);
process.stdout.write(process.env.CLAUDE_GEMINI_ADAPTER_KEY);
