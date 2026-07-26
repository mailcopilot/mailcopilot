import { describe, it, expect } from 'vitest';
import { isTransientNetworkError, isLinuxInstallerError } from './transientErrors';

describe('isTransientNetworkError', () => {
  describe('Chromium net:: codes', () => {
    it.each([
      'net::ERR_PROXY_CONNECTION_FAILED',
      'net::ERR_NETWORK_CHANGED',
      'net::ERR_CONNECTION_CLOSED',
      'net::ERR_CONNECTION_RESET',
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_CONNECTION_ABORTED',
      'net::ERR_INTERNET_DISCONNECTED',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_TIMED_OUT',
      'net::ERR_HTTP2_PROTOCOL_ERROR',
    ])('treats %s as transient', (msg) => {
      expect(isTransientNetworkError(msg)).toBe(true);
    });
  });

  describe('non-transient Chromium codes that used to be misclassified', () => {
    // ERR_SSL_PROTOCOL_ERROR may indicate misconfigured server/CA, expired
    // cert or pinning mismatch. It must stay visible in telemetry.
    it('does NOT treat ERR_SSL_PROTOCOL_ERROR as transient', () => {
      expect(isTransientNetworkError('net::ERR_SSL_PROTOCOL_ERROR')).toBe(false);
      expect(
        isTransientNetworkError(
          "Error: Error invoking remote method 'update:download': Error: net::ERR_SSL_PROTOCOL_ERROR",
        ),
      ).toBe(false);
    });

    // ERR_CONTENT_LENGTH_MISMATCH may indicate a corrupted update artifact
    // or a broken CDN — needs visibility.
    it('does NOT treat ERR_CONTENT_LENGTH_MISMATCH as transient', () => {
      expect(isTransientNetworkError('net::ERR_CONTENT_LENGTH_MISMATCH')).toBe(false);
    });
  });

  describe('Node.js syscall codes', () => {
    it.each([
      'read ECONNRESET',
      'connect ECONNREFUSED 1.2.3.4:993',
      'connect ETIMEDOUT',
      'getaddrinfo ENOTFOUND imap.example.com',
      'connect EHOSTUNREACH',
      'write EPIPE',
      'getaddrinfo EAI_AGAIN',
    ])('treats %s as transient', (msg) => {
      expect(isTransientNetworkError(msg)).toBe(true);
    });
  });

  describe('library phrases', () => {
    it('treats imapflow "Connection not available" as transient', () => {
      expect(isTransientNetworkError('Connection not available')).toBe(true);
    });

    it('treats "Socket timeout" as transient', () => {
      expect(isTransientNetworkError('Socket timeout')).toBe(true);
    });

    it('treats "socket hang up" as transient', () => {
      expect(isTransientNetworkError('socket hang up')).toBe(true);
    });
  });

  describe('MAILCOPILOT-N regression cases', () => {
    it('MAILCOPILOT-3: ERR_HTTP2_PROTOCOL_ERROR from autoUpdater', () => {
      expect(isTransientNetworkError('Error: net::ERR_HTTP2_PROTOCOL_ERROR')).toBe(true);
    });

    it('MAILCOPILOT-8: wrapped renderer ERR_CONNECTION_RESET', () => {
      expect(
        isTransientNetworkError(
          "Error: Error invoking remote method 'update:download': Error: net::ERR_CONNECTION_RESET",
        ),
      ).toBe(true);
    });

    it('MAILCOPILOT-A: wrapped renderer ERR_HTTP2_PROTOCOL_ERROR', () => {
      expect(
        isTransientNetworkError(
          "Error: Error invoking remote method 'update:download': Error: net::ERR_HTTP2_PROTOCOL_ERROR",
        ),
      ).toBe(true);
    });

    it('MAILCOPILOT-4: TLSWrap read ECONNRESET', () => {
      expect(isTransientNetworkError('read ECONNRESET')).toBe(true);
    });

    it('MAILCOPILOT-5: imapflow Connection not available', () => {
      expect(isTransientNetworkError('Connection not available')).toBe(true);
    });
  });

  describe('non-transient errors', () => {
    it.each([
      'TypeError: Cannot read property "foo" of undefined',
      'SyntaxError: Unexpected token',
      'Error: Invalid credentials',
      'ReferenceError: x is not defined',
      '',
    ])('does not treat %s as transient', (msg) => {
      expect(isTransientNetworkError(msg)).toBe(false);
    });

    it('handles null/undefined', () => {
      expect(isTransientNetworkError(null)).toBe(false);
      expect(isTransientNetworkError(undefined)).toBe(false);
    });

    it('handles Error instance', () => {
      expect(isTransientNetworkError(new Error('read ECONNRESET'))).toBe(true);
      expect(isTransientNetworkError(new Error('boom'))).toBe(false);
    });

    it('handles object with message field', () => {
      expect(isTransientNetworkError({ message: 'Socket timeout' })).toBe(true);
      expect(isTransientNetworkError({ message: 'ok' })).toBe(false);
      expect(isTransientNetworkError({})).toBe(false);
    });

    it('handles object with syscall code field', () => {
      expect(isTransientNetworkError({ code: 'ECONNRESET', message: 'boom' })).toBe(true);
      expect(isTransientNetworkError({ code: 'ENOENT', message: 'boom' })).toBe(false);
    });
  });

  describe('wrapped errors via cause chain', () => {
    it('walks err.cause and detects transient inner error', () => {
      const inner = new Error('read ECONNRESET');
      const outer = Object.assign(new Error('Failed to fetch'), { cause: inner });
      expect(isTransientNetworkError(outer)).toBe(true);
    });

    it('walks nested cause chain (depth > 1)', () => {
      const deepest = new Error('Socket timeout');
      const mid = Object.assign(new Error('wrapper'), { cause: deepest });
      const top = Object.assign(new Error('top-level'), { cause: mid });
      expect(isTransientNetworkError(top)).toBe(true);
    });

    it('does not classify as transient when cause chain is all real errors', () => {
      const inner = new Error('Invalid credentials');
      const outer = Object.assign(new Error('Auth failed'), { cause: inner });
      expect(isTransientNetworkError(outer)).toBe(false);
    });

    it('bounds cause-walk depth against cyclic references', () => {
      // Construct a cycle: a.cause = b, b.cause = a.
      const a = new Error('boom a') as Error & { cause?: unknown };
      const b = new Error('boom b') as Error & { cause?: unknown };
      a.cause = b;
      b.cause = a;
      // Neither is transient, and the walker must terminate.
      expect(isTransientNetworkError(a)).toBe(false);
    });

    it('respects MAX_CAUSE_DEPTH and does not infinitely recurse', () => {
      // Build a chain deeper than MAX_CAUSE_DEPTH (5) with a transient
      // tail. The classifier should stop walking before reaching it — the
      // outer error stays visible.
      let cur: Error & { cause?: unknown } = new Error('read ECONNRESET');
      for (let i = 0; i < 10; i++) {
        cur = Object.assign(new Error(`wrapper ${i}`), { cause: cur });
      }
      // With depth-limited walk we cannot observe the transient leaf, so
      // we stay conservative and return false.
      expect(isTransientNetworkError(cur)).toBe(false);
    });
  });

  describe('AggregateError-shaped payloads', () => {
    // We avoid `new AggregateError(...)` to keep the TS lib target at
    // ES2020; the classifier only checks for an `errors` array, so a
    // plain object with the same shape is equivalent.
    it('returns true when all inner errors are transient', () => {
      const agg = Object.assign(new Error('all failed'), {
        errors: [new Error('read ECONNRESET'), new Error('Socket timeout')],
      });
      expect(isTransientNetworkError(agg)).toBe(true);
    });

    it('returns false when any inner error is non-transient', () => {
      const agg = Object.assign(new Error('mixed'), {
        errors: [new Error('read ECONNRESET'), new Error('TypeError: boom')],
      });
      expect(isTransientNetworkError(agg)).toBe(false);
    });

    it('empty errors array → not transient', () => {
      const agg = Object.assign(new Error('empty'), { errors: [] as Error[] });
      expect(isTransientNetworkError(agg)).toBe(false);
    });
  });
});

describe('isLinuxInstallerError', () => {
  it('MAILCOPILOT-9: pkexec exit 127', () => {
    expect(
      isLinuxInstallerError(
        'Command /usr/bin/pkexec --disable-internal-agent exited with code 127',
      ),
    ).toBe(true);
  });

  it('detects dpkg failures with exit code', () => {
    expect(
      isLinuxInstallerError('Command dpkg -i app.deb exited with code 1'),
    ).toBe(true);
  });

  it('detects apt-get failures with exit code', () => {
    expect(
      isLinuxInstallerError('Command apt-get install exited with code 100'),
    ).toBe(true);
  });

  it('does not flag unrelated exit-code errors', () => {
    expect(isLinuxInstallerError('Command foo exited with code 1')).toBe(false);
  });

  it('does not flag transient net errors', () => {
    expect(isLinuxInstallerError('net::ERR_CONNECTION_RESET')).toBe(false);
  });

  it('handles null/undefined', () => {
    expect(isLinuxInstallerError(null)).toBe(false);
    expect(isLinuxInstallerError(undefined)).toBe(false);
  });
});
