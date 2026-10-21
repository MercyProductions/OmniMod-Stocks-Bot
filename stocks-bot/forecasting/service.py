"""Loopback-only, authenticated research inference. Put TLS at a controlled proxy for remote use."""
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from engine import Warehouse, load_model


def make_server(database, token, model=None, port=8792):
    if not token or len(token) < 32:
        raise ValueError('a dedicated research token of at least 32 characters is required')
    store = Warehouse(database)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Authorization headers and payloads must never enter HTTP logs.

        def do_POST(self):
            self.connection.settimeout(10)
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.reply(401, {'error': 'unauthorized'})
                return
            if self.path != '/forecast':
                self.reply(404, {'error': 'unknown_route'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 2_000_000 or self.headers.get('Transfer-Encoding'):
                    self.reply(413, {'error': 'invalid_body_length'})
                    return
                body = self.rfile.read(size)
                if len(body) != size:
                    raise ValueError('short body')
                observation = json.loads(body)
                with store.db:
                    forecasts = store.forecasts(observation, model)
                self.reply(200, {'forecasts': forecasts})
            except Exception:
                self.reply(400, {'error': 'invalid_or_conflicting_research_observation'})

        def reply(self, status, body):
            payload = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(payload)
            self.close_connection = True

    server = HTTPServer(('127.0.0.1', port), Handler)
    server.store = store
    return server


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', required=True)
    parser.add_argument('--model')
    parser.add_argument('--port', type=int, default=8792)
    args = parser.parse_args()
    server = make_server(args.db, os.getenv('STOCKS_FORECAST_TOKEN'), load_model(args.model) if args.model else None, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.store.db.close()
