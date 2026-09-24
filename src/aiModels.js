// Central Claude model ID registry.
// When Anthropic releases new models, update ONLY these constants.
// All files import from here — never hardcode model IDs elsewhere.
const CLAUDE_SONNET = 'claude-sonnet-4-6';
const CLAUDE_HAIKU = 'claude-haiku-4-5';

module.exports = { CLAUDE_SONNET, CLAUDE_HAIKU };
