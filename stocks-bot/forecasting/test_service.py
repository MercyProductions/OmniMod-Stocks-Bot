import http.client
import json
import queue
import threading
import subprocess
import os
import tempfile
import unittest
from pathlib import Path
from test_engine import observation
from service import make_server


class ServiceTests(unittest.TestCase):
    def test_authenticated_immutable_forecasting_over_actual_http(self):
        with tempfile.TemporaryDirectory() as directory:
            token='test-only-not-a-real-credential-0123456789'
            ready=queue.Queue()
            def run():
                server=make_server(Path(directory)/'research.sqlite',token,port=0)
                ready.put(server)
                try:
                    server.serve_forever(poll_interval=.01)
                finally:
                    server.server_close()
                    server.store.db.close()
            thread=threading.Thread(target=run)
            thread.start()
            server=ready.get(timeout=5)
            port=server.server_address[1]
            try:
                def request(item, authorized=True):
                    connection=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
                    headers={'Content-Type':'application/json'}
                    if authorized:
                        headers['Authorization']='Bearer '+token
                    connection.request('POST','/forecast',json.dumps(item),headers)
                    response=connection.getresponse()
                    result=(response.status,json.loads(response.read()))
                    connection.close()
                    return result
                self.assertEqual(request(observation(),False)[0],401)
                status,body=request(observation())
                self.assertEqual(status,200)
                self.assertEqual(len(body['forecasts']),6)
                self.assertEqual(request(observation())[1],body)
                self.assertTrue(all(row['status']=='abstain' for row in body['forecasts']))
                # Exercise the real Node client against the Python service, without Discord or provider calls.
                script = """import fs from 'node:fs';
import {requestPredictiveForecast} from './src/predictiveClient.js';
const result=await requestPredictiveForecast(JSON.parse(fs.readFileSync(0,'utf8')),
 {endpoint:process.env.TEST_FORECAST_URL,token:process.env.TEST_FORECAST_TOKEN});
process.stdout.write(JSON.stringify({count:result.forecasts.length,productionOrders:0}));"""
                node = subprocess.run(['node','--input-type=module','-e',script],cwd=Path(__file__).resolve().parent.parent,
                    input=json.dumps(observation()),text=True,capture_output=True,timeout=15,
                    env=dict(os.environ,TEST_FORECAST_URL=f'http://127.0.0.1:{port}/forecast',TEST_FORECAST_TOKEN=token))
                self.assertEqual(node.returncode,0,node.stderr)
                self.assertEqual(json.loads(node.stdout)['count'],6)
                altered=observation(); altered['price']=200
                self.assertEqual(request(altered)[0],400)
                self.assertEqual(request({'schema':'wrong'})[0],400)
            finally:
                server.shutdown()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())


if __name__=='__main__':
    unittest.main()
