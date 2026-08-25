# ArgusTrench

GMGN / pump.fun auto-trading system. Αρχιτεκτονική, decision philosophy και phased
rollout: [`CLAUDE.md`](./CLAUDE.md). Αυτό το README καλύπτει μόνο setup & deploy.

Τρέχουσα κατάσταση: **Φάση 0 — scaffolding**. Δεν υπάρχει ακόμα decision logic ή
entrypoint· μόνο DB layer + migrations.

## Prerequisites

- Node.js >= 20 (δοκιμασμένο σε 24)
- Docker Desktop ή OrbStack — για το τοπικό Postgres. **Δεν χρειάζεται `psql` στο host**:
  ο migration runner είναι σε Node, και για shell υπάρχει `npm run db:psql` μέσα στο
  container.

## Dev setup

```bash
cp .env.example .env      # οι default τιμές ταιριάζουν με το docker-compose.yml
npm install
npm run db:up             # Postgres 16 σε container, περιμένει healthcheck
npm run migrate           # εφαρμόζει τα migrations/*.sql
npm run migrate:status     # τι έχει εφαρμοστεί / τι λείπει
```

Άλλα: `npm run db:down` (σταματά, κρατά τα δεδομένα) · `npm run db:reset`
(**σβήνει το volume** και ξεκινά καθαρό) · `npm run db:psql` (psql shell).

## Running

```bash
npm run dev        # tsx watch, για development
npm start          # node dist/main.js, μετά από npm run build
```

Ένα process για όλα: το Telegram bot + τρία collector loops της Φάσης 1.

| Loop | Interval | Τι κάνει |
|---|---|---|
| `discovery` | 30s | δύο `trenches` calls (gated + ungated), γράφει `decision_log` |
| `wallet-activity` | 60s | `portfolio activity --type buy` ανά active wallet, βρίσκει triggers |
| `manual-scoring` | 300s | ξανα-σκοράρει τα manual wallets, alert σε πτώση |

Όλα σέβονται **κοινό cooldown**: ο rate limiter της GMGN είναι ανά API key, όχι ανά route,
οπότε ένα 429 σε ένα loop παγώνει όλα τα υπόλοιπα μέχρι το `retryAt`. Αν συνέχιζαν, κάθε
request τους θα επέκτεινε το ban κατά 5s (έως 5 λεπτά).

**Βρες το chat id σου**: ξεκίνα το process με κενό `TELEGRAM_CHAT_ID`, στείλε μήνυμα στο
bot, και το log θα γράψει `rejected: chat <id> is not in the allowlist`. Βάλε το id στο
`.env` και ξαναξεκίνα. Κενή allowlist απορρίπτει **τα πάντα** — δες "Authorization" στο
`CLAUDE.md`.

## Tests

```bash
npm run db:up && npm test      # χρειάζεται το container πάνω
```

`node:test` (built-in, χωρίς test framework dependency). Τα tests είναι **integration**
πάνω στο dev Postgres, όχι unit με mocks: ό,τι επαληθεύουν — CHECK constraints, η κυκλική
FK, οι τύποι που επιστρέφει ο driver — ζει στη βάση, και ένα mock θα τα έκρυβε όλα.

Κάθε test τρέχει μέσα σε transaction που γίνεται πάντα rollback, άρα δεν αφήνει δεδομένα
και δεν εξαρτάται από σειρά εκτέλεσης. Τα assertions για counts είναι delta-based, ώστε
να μη σπάσουν όταν η Φάση 1 αρχίσει να γράφει πραγματικά δεδομένα στην ίδια βάση.

## Migrations

Απλός forward-only runner (`src/db/migrate.ts`):

- Τρέχει τα `migrations/*.sql` με σειρά ονόματος, ένα transaction ανά αρχείο.
- Καταγράφει ό,τι εφαρμόστηκε στο `schema_migrations`, οπότε τα αρχεία **δεν** χρειάζεται
  να είναι idempotent — τρέχουν μία φορά.
- `pg_advisory_lock` ώστε δύο ταυτόχρονα deploys να μη τα τρέξουν διπλά.
- Χρειάζεται μόνο `DATABASE_URL`, άρα ίδιο σκριπτ σε local / CI / Railway.

Νέο migration = νέο αρχείο με επόμενο prefix (`0003_*.sql`). Ποτέ edit σε εφαρμοσμένο
αρχείο — δε θα ξανατρέξει.

## Deploy (GitHub → Railway)

Push στο `master` → Railway auto-deploy. Στο Railway project:

1. **Postgres plugin** — δίνει το `DATABASE_URL` μόνο του, μέσω reference variable.
   Μην το γράφεις χειροκίνητα. Κράτα τον major version ίδιο με το compose (16).
2. **Build & start**: build command `npm run build`, start command `npm start`.
   Pre-deploy command: `npm run migrate:prod` — τρέχει το compiled `dist/db/migrate.js`,
   όχι το `tsx` script, γιατί τα devDependencies κόβονται στο production install.
   Προϋποθέτει ότι το build έχει τρέξει πριν.
3. **Variables**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GMGN_API_KEY`,
   `GMGN_PRIVATE_KEY` (βλ. παρακάτω).
4. **`GMGN_ALLOW_AUTOMATED_TRADES`**: μένει **unset** μέχρι τη Φάση 5. Είναι το
   paper/live switch — μόνο η τιμή `1` ενεργοποιεί αυτόματες συναλλαγές.

**`GMGN_API_KEY` / `GMGN_PRIVATE_KEY` ΠΡΕΠΕΙ να μπουν ως Railway variables** —
αντίθετα με το dev workflow (`gmgn-cli config --apply <key>`, γράφει στο
`~/.config/gmgn/.env`), ένα ephemeral Railway container δεν έχει persistent `~/.config`
και δεν υπάρχει interactive βήμα εκεί για να τρέξει το `config --apply`. Επιβεβαιωμένο
(2026-08-26, με άδειο `HOME`) ότι το `gmgn-cli` διαβάζει αυτές τις δύο μεταβλητές
απευθείας από το process environment αν υπάρχουν — και το δικό μας `execFile` περνάει
όλο το parent env στο child process αυτόματα, άρα δε χρειάζεται καμία αλλαγή κώδικα,
μόνο να οριστούν στο Railway dashboard. Τιμές από `~/.config/gmgn/.env` τοπικά.

**`gmgn-cli` είναι project dependency** (`package.json`), όχι global install — το
build το εγκαθιστά μόνο του μέσω `npm install`. Ένα test (`gmgn.test.ts`) επιβεβαιώνει
ότι το `node_modules/.bin/gmgn-cli` υπάρχει μετά το install, ώστε μια κατά λάθος
αφαίρεσή του να σκάσει στο CI, όχι σιωπηλά σε production.
