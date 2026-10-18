/** Web API tokens: `vm_` followed by 60 lowercase hex digits. Read and write tokens share this format. */
const API_TOKEN = /^vm_[a-f0-9]{60}$/;
const API_TOKEN_ANYWHERE = /vm_[a-f0-9]{60}/g;

const isApiToken = value => typeof value === 'string' && API_TOKEN.test(value);
const redactApiTokens = text => String(text).replace(API_TOKEN_ANYWHERE, '[redacted]');

module.exports = { isApiToken, redactApiTokens };
