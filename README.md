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
2. **Pre-deploy command**: `npm run migrate:prod` — τρέχει το compiled
   `dist/db/migrate.js`, όχι το `tsx` script, γιατί τα devDependencies κόβονται στο
   production install. Προϋποθέτει ότι το build έχει τρέξει (`npm run build`).
3. **Variables**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. **`GMGN_ALLOW_AUTOMATED_TRADES`**: μένει **unset** μέχρι τη Φάση 5. Είναι το
   paper/live switch — μόνο η τιμή `1` ενεργοποιεί αυτόματες συναλλαγές.

Το `GMGN_API_KEY` δε ζει στο project env: το `gmgn-cli` κρατά δικό του global config
(`~/.config/gmgn/.env`) μέσω `gmgn-cli config --apply <key>`.
