// Supabase JS wraps Edge Function non-2xx responses in a FunctionsHttpError
// whose `.message` is the generic "Edge Function returned a non-2xx status
// code" and whose `.context` is the underlying Response. The Response body
// is where rapid-processor (and every other function in this repo) returns
// its actionable JSON like `{error: "User already registered"}` — the
// generic message strips that.
//
// `unwrapEdgeFunctionError(err)` reads `err.context.text()`, attempts to
// parse JSON, and returns the most useful string to surface to the user.
// Resolution order:
//   1. err.context body parsed JSON: parsed.error / parsed.message
//   2. err.context raw text (when body isn't JSON)
//   3. err.message
//   4. 'Unknown error'
//
// Always returns a non-empty string; never throws (any failure inside the
// unwrap falls through to the next candidate).

export async function unwrapEdgeFunctionError(err) {
  if (err && err.context && typeof err.context.text === 'function') {
    try {
      const body = await err.context.text();
      if (body) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.error === 'string' && parsed.error) return parsed.error;
          if (parsed && typeof parsed.message === 'string' && parsed.message) return parsed.message;
        } catch (_jsonErr) {
          // Body wasn't JSON — fall back to raw text.
          return body;
        }
      }
    } catch (_readErr) {
      // Body already consumed or read failed — fall through to .message.
    }
  }
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return 'Unknown error';
}
