import path from 'node:path';
import {config,dataDir} from '../src/config.js';
import {writeJson} from '../src/storage.js';
import {probeAlpacaDataAccess} from '../src/alpacaDataReadiness.js';

// No Discord startup, brokerage execution, account writes, paid upgrades or automatic training.
const result=await probeAlpacaDataAccess({keyId:config.alpacaKeyId,secretKey:config.alpacaSecretKey});
const file=path.join(dataDir,'research','alpaca-data-readiness.json');
await writeJson(file,result);
console.log(JSON.stringify(result,null,2));
if(!['data_access_verified','credentials_missing'].includes(result.status)) process.exitCode=1;
