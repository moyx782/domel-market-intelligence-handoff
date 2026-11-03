#!/usr/bin/env node
// T0 operator CLI. This is the only place allowed to grant the system role or
// change the CLI switches; the web UI cannot do either.
import {openAgentStore} from '../server/agent-config.mjs';

const store = openAgentStore(process.env.AGENT_DATA_DIR || '.local');
const [command, ...args] = process.argv.slice(2);

function usage(){
 console.log(`Usage:
  node scripts/agent-admin.mjs show
  node scripts/agent-admin.mjs role <system|admin|user|viewer>
  node scripts/agent-admin.mjs cli --enabled on|off --bash on|off`);
 process.exit(1);
}

if(command === 'show'){
 console.log(JSON.stringify({role: store.config().role, cli: store.cli()}, null, 2));
} else if(command === 'role'){
 const role = args[0];
 if(!['system','admin','user','viewer'].includes(role)) usage();
 store.setSettings({role});
 console.log('role = ' + role);
} else if(command === 'cli'){
 const patch = {};
 for(let index = 0; index < args.length; index += 2){
  const key = args[index];
  const value = args[index + 1];
  if(!['--enabled','--bash'].includes(key) || !['on','off'].includes(value)) usage();
  if(key === '--enabled') patch.enabled = value === 'on';
  if(key === '--bash') patch.allowBash = value === 'on';
 }
 if(!Object.keys(patch).length) usage();
 store.setSettings({cli: patch}, {allowCli: true});
 console.log('cli = ' + JSON.stringify(store.cli()));
} else {
 usage();
}
