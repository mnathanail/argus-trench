import 'dotenv/config';
import WebSocket from 'ws';

const [walletArg, tokenArg] = process.argv.slice(2);
if (!walletArg) {
  console.error('Χρήση: tsx scripts/verify-pumpportal-ws.ts <wallet-address> [token-address]');
  process.exit(1);
}

const apiKey = process.env.PUMPPORTAL_API_KEY;
if (!apiKey) {
  console.error('Λείπει το PUMPPORTAL_API_KEY (env var ή .env).');
  process.exit(1);
}

const masked = apiKey.length > 10 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : '(πολύ κοντό;)';
console.log(`API key: ${masked} (μήκος ${apiKey.length})`);
if (apiKey !== apiKey.trim()) {
  console.log('⚠️  Το key έχει κενά στην αρχή/τέλος — πιθανό πρόβλημα στο .env.');
}
if (apiKey.startsWith('"') || apiKey.startsWith("'")) {
  console.log('⚠️  Το key ξεκινάει με εισαγωγικό — αφαίρεσέ το από το .env (χωρίς "" γύρω).');
}

const url = `wss://pumpportal.fun/api/data?api-key=${apiKey}`;
console.log(`Σύνδεση σε: wss://pumpportal.fun/api/data?api-key=${masked}`);

const ws = new WebSocket(url);

function log(label: string, payload: unknown): void {
  console.log(`\n[${new Date().toISOString()}] ${label}`);
  console.log(JSON.stringify(payload, null, 2));
}

ws.on('open', () => {
  console.log('Συνδέθηκε.');
  ws.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: [walletArg] }));
  console.log(`→ subscribeAccountTrade: ${walletArg}`);
  if (tokenArg) {
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [tokenArg] }));
    console.log(`→ subscribeTokenTrade: ${tokenArg}`);
  }
  console.log('\nΠεριμένω events... (Ctrl+C για έξοδο)');
});

ws.on('message', (raw) => {
  try {
    log('EVENT', JSON.parse(raw.toString()));
  } catch {
    log('EVENT (μη-JSON, ωμό)', raw.toString());
  }
});

ws.on('error', (error) => {
  log('ERROR', { message: error.message });
});

ws.on('close', (code, reason) => {
  log('CLOSED', { code, reason: reason.toString() });
});

process.on('SIGINT', () => {
  console.log('\nΚλείνω τη σύνδεση...');
  ws.close();
  process.exit(0);
});
