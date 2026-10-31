import http from 'node:http';

/**
 * A raw request to the console. `fetch` will not set `Host` or `Origin`, and
 * those two headers are what the console's guards are about.
 */
export function consoleRequest(options: {
  port: number;
  path: string;
  method?: string;
  host?: string;
  origin?: string | null;
  form?: Record<string, string>;
  contentType?: string;
}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString() : undefined;
    const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${options.port}` };
    if (options.origin !== null && options.origin !== undefined) headers.origin = options.origin;
    if (body !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/x-www-form-urlencoded';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      { host: '127.0.0.1', port: options.port, path: options.path, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
