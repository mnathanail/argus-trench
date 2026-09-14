/**
 * Ενεργοποιεί proxy (TRADE_PROXY_URL, αν έχει οριστεί) ΜΟΝΟ για τη δική μας τρέχουσα
 * διαδικασία — ΟΧΙ ως γενική HTTP_PROXY/HTTPS_PROXY μεταβλητή σε επίπεδο Railway service.
 * Πραγματικό incident 2026-09-14: μια τέτοια γενική μεταβλητή έκανε ΚΑΙ το build tooling
 * του Railway ("mise") να προσπαθήσει να περάσει από το proxy, απέτυχε στην
 * αυθεντικοποίηση, και έριξε ΟΛΟΚΛΗΡΟ το deploy πριν καν τρέξει ο δικός μας κώδικας.
 *
 * Κάθε entrypoint (main.ts, και κάθε standalone script που αγγίζει gmgn-cli) καλεί αυτό
 * ΠΡΩΤΟ, πριν από οποιοδήποτε import που θα μπορούσε να κάνει πραγματική κλήση.
 */
export function activateTradeProxyIfConfigured(): void {
  const tradeProxyUrl = process.env.TRADE_PROXY_URL;
  if (tradeProxyUrl) {
    process.env.HTTP_PROXY = tradeProxyUrl;
    process.env.HTTPS_PROXY = tradeProxyUrl;
    console.log('[proxy] trade proxy ενεργό (TRADE_PROXY_URL ορίστηκε)');
  }
}
