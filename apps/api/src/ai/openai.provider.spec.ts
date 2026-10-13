/**
 * Phase 49J-B: unit coverage for the embedding contract.
 *
 * `fetch` is mocked, so these tests assert what the provider ASKS FOR (endpoint, auth
 * header, `dimensions`, `encoding_format`) and what it REFUSES TO RETURN (any vector that
 * is not exactly the configured width). No network, no API key, no cost.
 *
 * The point of the width assertions is not defensiveness for its own sake: a wrong-width
 * vector reaching a caller means it reaches storage, and a vector store with mixed widths
 * cannot be queried at all. These tests pin that failure at the provider boundary.
 */
import { BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
import { DEFAULT_EMBEDDING_DIMENSION, DEFAULT_EMBEDDING_MODEL } from './i-ai-provider';
import {
  MAX_EMBEDDING_BATCH,
  MAX_EMBEDDING_INPUT_CHARS,
  MAX_EMBEDDING_TIMEOUT_MS,
  MIN_EMBEDDING_TIMEOUT_MS,
  OpenAIProvider,
} from './openai.provider';

/** Deterministic vector of the requested width; values are irrelevant, the length is not. */
const vectorOf = (length: number, seed = 0.1): number[] =>
  Array.from({ length }, (_, i) => seed + i / 100000);

const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  }) as unknown as Response;

const errorResponse = (status: number, body = '{"error":{"message":"nope"}}'): Response =>
  ({
    ok: false,
    status,
    json: jest.fn().mockResolvedValue(JSON.parse(body)),
    text: jest.fn().mockResolvedValue(body),
  }) as unknown as Response;

/** Shapes one `data[]` item the way the API documents it. */
const item = (index: number, embedding: unknown) => ({ object: 'embedding', index, embedding });

/** The request body this provider is expected to build. */
interface EmbeddingRequestBody {
  model: string;
  input: string[];
  encoding_format: string;
  dimensions?: number;
}

describe('OpenAIProvider (49J-B embeddings)', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  /** The parsed JSON body of the Nth fetch call. */
  const requestBody = (call = 0): EmbeddingRequestBody =>
    JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);

  const requestInit = (call = 0): RequestInit => fetchMock.mock.calls[call][1] as RequestInit;

  beforeEach(() => {
    jest.restoreAllMocks();
    // The provider logs a warning when no key is present and on a bad dimension; silence it
    // so a passing run is not full of expected noise.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(undefined);

    process.env.OPENAI_API_KEY = 'sk-test-key';
    delete process.env.OPENAI_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIMENSION;
    delete process.env.EMBEDDING_TIMEOUT_MS;

    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  describe('request shape', () => {
    it('posts to /embeddings with the model, dimensions and float encoding', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('quarterly revenue by branch');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/embeddings');

      const init = requestInit();
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test-key',
      });

      // `dimensions` is the whole point: it is what makes 1536 a contract rather than a
      // property of whichever model happens to be configured.
      expect(requestBody()).toEqual({
        model: DEFAULT_EMBEDDING_MODEL,
        input: ['quarterly revenue by branch'],
        encoding_format: 'float',
        dimensions: DEFAULT_EMBEDDING_DIMENSION,
      });
    });

    it('always sends input as an array, even for a single string', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('one');

      expect(requestBody().input).toEqual(['one']);
    });

    it('passes an abort signal so a hung upstream cannot wedge the request', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x');

      expect(requestInit().signal).toBeInstanceOf(AbortSignal);
    });

    it('strips trailing slashes from a custom base URL instead of doubling them', async () => {
      process.env.OPENAI_BASE_URL = 'https://gateway.internal/v1///';
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x');

      expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.internal/v1/embeddings');
    });

    it('omits dimensions for models that do not accept the parameter', async () => {
      // ada-002 answers 400 if `dimensions` is sent, so it must not be sent.
      process.env.EMBEDDING_MODEL = 'text-embedding-ada-002';
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x');

      expect(requestBody()).not.toHaveProperty('dimensions');
      // The width is still enforced on the way back out — just checked, not requested.
      expect(requestBody().model).toBe('text-embedding-ada-002');
    });
  });

  describe('vector contract', () => {
    it('returns the vector at data[].embedding with the configured width', async () => {
      const expected = vectorOf(DEFAULT_EMBEDDING_DIMENSION);
      fetchMock.mockResolvedValue(okResponse({ data: [item(0, expected)] }));

      const vector = await new OpenAIProvider().generateEmbedding('نرخ ارز امروز چند است؟');

      expect(vector).toHaveLength(DEFAULT_EMBEDDING_DIMENSION);
      expect(vector).toEqual(expected);
    });

    it('embeds Persian text unmodified - no trimming, no normalisation', async () => {
      // RTL text with surrounding whitespace: the caller's string must reach the API exactly
      // as given, otherwise the stored vector describes something they never sent.
      const persian = '  قرارداد فروش با شرکت آریا امضا شد.  ';
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding(persian);

      expect(requestBody().input).toEqual([persian]);
    });

    it('throws when the provider returns the wrong number of floats', async () => {
      // The realistic failure: EMBEDDING_MODEL points at -3-large, `dimensions` is ignored
      // by a proxy, and 3072 floats come back. Storing that silently corrupts the index.
      fetchMock.mockResolvedValue(okResponse({ data: [item(0, vectorOf(3072))] }));

      const provider = new OpenAIProvider();
      await expect(provider.generateEmbedding('x')).rejects.toThrow(InternalServerErrorException);
      await expect(provider.generateEmbedding('x')).rejects.toThrow(
        `expected ${DEFAULT_EMBEDDING_DIMENSION}, received 3072`
      );
    });

    it('honours an EMBEDDING_DIMENSION override on both request and response', async () => {
      process.env.EMBEDDING_DIMENSION = '512';
      fetchMock.mockResolvedValue(okResponse({ data: [item(0, vectorOf(512))] }));

      const provider = new OpenAIProvider();
      const vector = await provider.generateEmbedding('x');

      expect(requestBody().dimensions).toBe(512);
      expect(vector).toHaveLength(512);
      expect(provider.getEmbeddingContract()).toEqual({
        model: DEFAULT_EMBEDDING_MODEL,
        dimension: 512,
      });
    });

    it('falls back to the default when EMBEDDING_DIMENSION is not a positive integer', async () => {
      // parseInt('1536abc') would silently be 1536; Number() rejects it, which is the point.
      process.env.EMBEDDING_DIMENSION = '1536abc';
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      const provider = new OpenAIProvider();
      await provider.generateEmbedding('x');

      expect(provider.getEmbeddingContract().dimension).toBe(DEFAULT_EMBEDDING_DIMENSION);
      expect(requestBody().dimensions).toBe(DEFAULT_EMBEDDING_DIMENSION);
    });

    it('rejects a vector containing NaN or Infinity', async () => {
      // Non-finite values propagate through cosine distance and quietly break ranking.
      const poisoned = vectorOf(DEFAULT_EMBEDDING_DIMENSION);
      poisoned[7] = Number.NaN;
      fetchMock.mockResolvedValue(okResponse({ data: [item(0, poisoned)] }));

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(/non-finite value/);
    });

    it('rejects a response with no data array', async () => {
      fetchMock.mockResolvedValue(okResponse({ object: 'list' }));

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(
        /returned 0 vectors, expected 1/
      );
    });

    it('rejects a data item whose embedding is not an array', async () => {
      fetchMock.mockResolvedValue(okResponse({ data: [item(0, 'not-a-vector')] }));

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(
        /did not contain a vector/
      );
    });

    it('rejects a body that is not valid JSON', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
      } as unknown as Response);

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(/not valid JSON/);
    });
  });

  describe('batch input', () => {
    it('sends one request for many inputs', async () => {
      fetchMock.mockResolvedValue(
        okResponse({
          data: [
            item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION, 0.1)),
            item(1, vectorOf(DEFAULT_EMBEDDING_DIMENSION, 0.2)),
            item(2, vectorOf(DEFAULT_EMBEDDING_DIMENSION, 0.3)),
          ],
        })
      );

      const vectors = await new OpenAIProvider().generateEmbeddingBatch(['a', 'b', 'c']);

      // One round-trip, not three: this is what makes a bulk index viable.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requestBody().input).toEqual(['a', 'b', 'c']);
      expect(vectors).toHaveLength(3);
      vectors.forEach((v) => expect(v).toHaveLength(DEFAULT_EMBEDDING_DIMENSION));
    });

    it('re-orders out-of-order data[] by index, not by arrival', async () => {
      // The API does not guarantee ordering. Trusting arrival order is how the right vector
      // gets attached to the wrong row, so ordering is asserted explicitly.
      const first = vectorOf(DEFAULT_EMBEDDING_DIMENSION, 0.11);
      const second = vectorOf(DEFAULT_EMBEDDING_DIMENSION, 0.22);
      fetchMock.mockResolvedValue(okResponse({ data: [item(1, second), item(0, first)] }));

      const vectors = await new OpenAIProvider().generateEmbeddingBatch(['first', 'second']);

      expect(vectors[0]).toEqual(first);
      expect(vectors[1]).toEqual(second);
    });

    it('rejects a response whose indices collide and leave a gap', async () => {
      const v = vectorOf(DEFAULT_EMBEDDING_DIMENSION);
      fetchMock.mockResolvedValue(okResponse({ data: [item(0, v), item(0, v)] }));

      await expect(new OpenAIProvider().generateEmbeddingBatch(['a', 'b'])).rejects.toThrow(
        /missing a vector for input 1/
      );
    });

    it('rejects a response with an out-of-range index', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(5, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(
        /referenced input 5, only 1 were sent/
      );
    });

    it('rejects a vector count that does not match the inputs sent', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await expect(new OpenAIProvider().generateEmbeddingBatch(['a', 'b'])).rejects.toThrow(
        /returned 1 vectors, expected 2/
      );
    });

    it('rejects an empty batch and an oversized batch without calling the API', async () => {
      const provider = new OpenAIProvider();

      await expect(provider.generateEmbeddingBatch([])).rejects.toThrow(BadRequestException);
      await expect(
        provider.generateEmbeddingBatch(new Array(MAX_EMBEDDING_BATCH + 1).fill('x'))
      ).rejects.toThrow(`exceeds ${MAX_EMBEDDING_BATCH} items`);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names the offending element when one batch entry is invalid', async () => {
      await expect(new OpenAIProvider().generateEmbeddingBatch(['fine', '   '])).rejects.toThrow(
        'Embedding texts[1] is required'
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('input validation', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   \n\t  '],
      ['undefined', undefined as unknown as string],
      ['null', null as unknown as string],
      ['a number', 42 as unknown as string],
    ])('rejects %s without spending a request', async (_label, value) => {
      await expect(new OpenAIProvider().generateEmbedding(value)).rejects.toThrow(
        BadRequestException
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects input longer than the character guard', async () => {
      await expect(
        new OpenAIProvider().generateEmbedding('x'.repeat(MAX_EMBEDDING_INPUT_CHARS + 1))
      ).rejects.toThrow(`exceeds ${MAX_EMBEDDING_INPUT_CHARS} characters`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts input exactly at the guard', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await expect(
        new OpenAIProvider().generateEmbedding('x'.repeat(MAX_EMBEDDING_INPUT_CHARS))
      ).resolves.toHaveLength(DEFAULT_EMBEDDING_DIMENSION);
    });
  });

  describe('failure handling', () => {
    it('maps a non-2xx response to a server error carrying the status', async () => {
      fetchMock.mockResolvedValue(errorResponse(429, '{"error":{"message":"rate limited"}}'));

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(
        'Embedding request failed with status 429'
      );
    });

    it.each([401, 400, 500, 503])('maps HTTP %i to a server error', async (status) => {
      fetchMock.mockResolvedValue(errorResponse(status));

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(
        InternalServerErrorException
      );
    });

    it('never leaks the upstream error body to the caller', async () => {
      // The body can echo request content. It is logged for operators, not thrown.
      fetchMock.mockResolvedValue(errorResponse(400, '{"error":{"message":"secret-detail"}}'));

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(
        /^Embedding request failed with status 400$/
      );
    });

    it('reports a timeout distinctly from a generic transport failure', async () => {
      const timeout = Object.assign(new Error('The operation was aborted'), {
        name: 'TimeoutError',
      });
      fetchMock.mockRejectedValue(timeout);

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(
        /timed out after 15000ms/
      );
    });

    it('maps an abort to the same timeout path', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(/timed out/);
    });

    it('maps a DNS/connection failure to a generic embedding failure', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND'), {
          name: 'TypeError',
        })
      );

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(
        /^Embedding request failed$/
      );
    });

    it('refuses to call the API when no key is configured', async () => {
      delete process.env.OPENAI_API_KEY;

      await expect(new OpenAIProvider().generateEmbedding('x')).rejects.toThrow(
        'OpenAI API key is not configured'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('constructs without a key so the module never blocks startup', () => {
      // AIModule is imported app-wide; throwing here would take down deployments that
      // never touch embeddings.
      delete process.env.OPENAI_API_KEY;

      expect(() => new OpenAIProvider()).not.toThrow();
    });

    it('picks up a key supplied after construction', async () => {
      delete process.env.OPENAI_API_KEY;
      const provider = new OpenAIProvider();

      process.env.OPENAI_API_KEY = 'sk-late';
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await provider.generateEmbedding('x');

      expect((requestInit().headers as Record<string, string>).Authorization).toBe(
        'Bearer sk-late'
      );
    });

    it('keeps the key and the input text out of every log call', async () => {
      const errorLog = jest.spyOn(Logger.prototype, 'error');
      fetchMock.mockResolvedValue(errorResponse(500, '{"error":{"message":"boom"}}'));

      await expect(new OpenAIProvider().generateEmbedding('محرمانه: حقوق کارکنان')).rejects.toThrow(
        InternalServerErrorException
      );

      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).not.toContain('sk-test-key');
      expect(logged).not.toContain('محرمانه');
    });
  });

  describe('timeout configuration', () => {
    it('clamps a too-small timeout up to the floor', async () => {
      process.env.EMBEDDING_TIMEOUT_MS = '5';
      const spy = jest.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x');

      expect(spy).toHaveBeenCalledWith(MIN_EMBEDDING_TIMEOUT_MS);
    });

    it('clamps a too-large timeout down to the ceiling', async () => {
      process.env.EMBEDDING_TIMEOUT_MS = '999999999';
      const spy = jest.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x');

      expect(spy).toHaveBeenCalledWith(MAX_EMBEDDING_TIMEOUT_MS);
    });

    it('ignores a non-numeric timeout', async () => {
      process.env.EMBEDDING_TIMEOUT_MS = 'soon';
      const spy = jest.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x');

      expect(spy).toHaveBeenCalledWith(15_000);
    });
  });

  describe('runtime-effective configuration (AI-ARCH-HARDENING §13/§6)', () => {
    it('uses the model from execution options for the request', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x', { model: 'text-embedding-3-large' });

      expect(requestBody().model).toBe('text-embedding-3-large');
      // The dimensions negotiation follows the model ACTUALLY sent, not the
      // environment bootstrap — both are text-embedding-3 here, so both accept it.
      expect(requestBody().dimensions).toBe(DEFAULT_EMBEDDING_DIMENSION);
    });

    it('negotiates dimensions by the EFFECTIVE model, not the bootstrap model', async () => {
      delete process.env.EMBEDDING_MODEL;
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x', { model: 'text-embedding-ada-002' });

      expect(requestBody().model).toBe('text-embedding-ada-002');
      // ada-002 answers 400 for `dimensions`; the parameter must not be sent.
      expect(requestBody().dimensions).toBeUndefined();
    });

    it('uses the baseUrl from execution options, normalising a trailing slash', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x', { baseUrl: 'http://ollama:11434/v1/' });

      expect(fetchMock.mock.calls[0][0]).toBe('http://ollama:11434/v1/embeddings');
    });

    it('uses an explicit credential WITHOUT writing the environment', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x', { credential: 'sk-explicit' });

      expect((requestInit().headers as Record<string, string>).Authorization).toBe(
        'Bearer sk-explicit'
      );
      expect(process.env.OPENAI_API_KEY).toBe('sk-test-key');
    });

    it('falls back to the environment when options omit a field', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] })
      );

      await new OpenAIProvider().generateEmbedding('x', { model: 'text-embedding-3-small' });

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/embeddings');
      expect((requestInit().headers as Record<string, string>).Authorization).toBe(
        'Bearer sk-test-key'
      );
    });

    it('two concurrent calls with different credentials never see each other key (§28)', async () => {
      // The delayed response forces the interleave: call B's request is built and
      // sent while call A is still awaiting its answer — the schedule under which
      // a `process.env` swap would have handed A the wrong Authorization header.
      fetchMock.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return okResponse({ data: [item(0, vectorOf(DEFAULT_EMBEDDING_DIMENSION))] });
      });

      const provider = new OpenAIProvider();
      await Promise.all([
        provider.generateEmbedding('first', { credential: 'sk-A' }),
        provider.generateEmbedding('second', { credential: 'sk-B' }),
      ]);

      const authorizations = fetchMock.mock.calls.map(
        (call) =>
          ((call[1] as RequestInit).headers as Record<string, string>).Authorization
      );

      expect(authorizations).toEqual(['Bearer sk-A', 'Bearer sk-B']);
      expect(process.env.OPENAI_API_KEY).toBe('sk-test-key');
    });

    it('classifies a missing key as CONFIGURATION_ERROR, without calling upstream', async () => {
      delete process.env.OPENAI_API_KEY;

      const error = await new OpenAIProvider().generateEmbedding('x').catch((err) => err);

      expect(error.code).toBe('CONFIGURATION_ERROR');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('unimplemented surface', () => {
    it('still refuses generateText and generateCompletion', async () => {
      const provider = new OpenAIProvider();

      // Phase 49J-B implements embeddings only; the rest must fail loudly, not return
      // something plausible.
      await expect(provider.generateText('hi')).rejects.toThrow('not implemented in Phase A');
      await expect(provider.generateCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        'not implemented in Phase A'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
