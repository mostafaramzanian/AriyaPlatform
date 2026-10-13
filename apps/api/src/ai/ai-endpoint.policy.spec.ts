import {
  AIEndpointPolicyError,
  assertAIEndpointAllowed,
  checkAIEndpoint,
} from './ai-endpoint.policy';

/**
 * Phase AI-ARCH-HARDENING (§18): the AI endpoint policy, asserted as a DECISION
 * TABLE — every row below is a fact a reviewer can diff against the class comment
 * in one pass. Three properties this file exists to pin:
 *
 *  1. BLOCKED MEANS BLOCKED: metadata/link-local addresses, unspecified addresses,
 *     multicast, embedded credentials and non-http(s) schemes never pass — in their
 *     IPv4 spelling, their IPv6 spelling, AND their v4-mapped IPv6 spelling (the
 *     one that walks past naive `includes('169.254')` checks after mapping).
 *  2. NO BYPASS: private and loopback addresses are accepted by the SAME code path
 *     as everything else — allowed uniformly because local LLM topology is a
 *     supported deployment, not carved out as a string-keyed exception that could
 *     be widened by a careless edit.
 *  3. ONE RULE FOR NAMES: hostnames (including the local LLM's `ollama`) are
 *     validated identically and never resolved — DNS is not consulted, so there is
 *     no rebinding theatre and no dependence on the pod's DNS view.
 */

describe('AI endpoint policy (§18)', () => {
  describe('allowed external endpoints', () => {
    it.each([
      ['https://api.openai.com/v1', 'HOSTNAME'],
      ['http://api.openai.com', 'HOSTNAME'],
      ['https://my-gateway.example.com/openai/v1/', 'HOSTNAME'],
      ['http://1.1.1.1/v1', 'EXTERNAL'],
      ['https://[2606:4700:4700::1111]/v1', 'EXTERNAL'],
    ])('%s → %s', (url, category) => {
      expect(checkAIEndpoint(url)).toMatchObject({ allowed: true, category });
    });
  });

  describe('allowed internal local endpoints — the local LLM topology', () => {
    it.each([
      ['http://ollama:11434', 'HOSTNAME'],
      ['http://vllm.internal:8000/v1', 'HOSTNAME'],
      ['http://10.0.5.7:8080/v1', 'INTERNAL'],
      ['http://172.16.9.9:8080', 'INTERNAL'],
      ['http://192.168.1.20:11434', 'INTERNAL'],
      ['http://127.0.0.1:11434', 'LOOPBACK'],
      ['http://localhost:11434', 'LOOPBACK'],
      ['http://[::1]:11434', 'LOOPBACK'],
      ['http://[fc00::1]:11434', 'INTERNAL'],
    ])('%s → %s', (url, category) => {
      expect(checkAIEndpoint(url)).toMatchObject({ allowed: true, category });
    });
  });

  describe('blocked addresses', () => {
    it.each([
      ['http://169.254.169.254/latest/meta-data/', 'link-local'],
      ['http://169.254.1.1/', 'link-local'],
      ['http://0.0.0.0/', 'unspecified'],
      ['http://224.0.0.1/', 'multicast or reserved'],
      ['http://255.255.255.255/', 'multicast or reserved'],
      ['http://[fe80::1]/', 'link-local'],
      ['http://[ff02::1]/', 'multicast'],
      ['http://[::]/', 'unspecified'],
      ['http://[::ffff:169.254.169.254]/', 'link-local'],
      ['ftp://files.example.com/', 'unsupported scheme'],
      ['javascript:alert(1)', 'unsupported scheme'],
      ['https://user:pass@api.openai.com/v1', 'embedded credentials'],
      ['not-a-url', 'not a valid absolute URL'],
    ])('%s', (url, reason) => {
      const check = checkAIEndpoint(url as string);

      expect(check.allowed).toBe(false);
      if (!check.allowed && reason) {
        expect(check.reason).toContain(reason);
      }
    });

    it('never lets a rejected address reach assertAIEndpointAllowed', () => {
      expect(() => assertAIEndpointAllowed('http://169.254.169.254/')).toThrow(
        AIEndpointPolicyError
      );
      expect(() => assertAIEndpointAllowed('https://api.openai.com/v1')).not.toThrow();
    });
  });

  describe('no bypass branches', () => {
    it('rejects userinfo before any address classification runs', () => {
      // The credential check cannot be skipped by pointing at a private address.
      expect(checkAIEndpoint('http://key:s3cret@10.0.0.1/')).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('embedded credentials'),
      });
    });

    it('classifies by ADDRESS shape, never by familiar string', () => {
      // `localhost.attacker.example` is a hostname like any other: it is validated,
      // not privileged — and it is not blocked either, because this policy makes no
      // name-based promises it cannot keep without DNS.
      expect(checkAIEndpoint('http://localhost.attacker.example/')).toMatchObject({
        allowed: true,
        category: 'HOSTNAME',
      });
    });
  });
});
