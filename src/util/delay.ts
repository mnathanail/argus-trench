/**
 * Μικρή, σκόπιμη παύση ανάμεσα σε διαδοχικά GMGN calls μέσα στο ΙΔΙΟ κύκλο ενός
 * per-item loop (wallet-activity, wallet-scoring, wallet-discovery holders/stats).
 *
 * Το `TokenBucket` παρακολουθεί συνολικό weight budget, όχι πυκνότητα — μια ριπή από
 * πολλά διαδοχικά calls μέσα σε λίγα χιλιοστά του δευτερολέπτου μπορεί να παραμένει
 * μέσα στο weight budget αλλά να παραβιάζει ένα ξεχωριστό, πιο αυστηρό burst-limit που
 * φαίνεται να επιβάλει το GMGN: παρατηρήθηκε `RATE_LIMIT_EXCEEDED` με ~30-60s reset σε
 * ΚΑΘΕ προσπάθεια του wallet-activity, ανεξάρτητα πόσο είχε περάσει από την προηγούμενη
 * (μέχρι και 10 λεπτά backoff, ίδιο αποτέλεσμα) — δηλαδή δεν ήταν θέμα συνολικού
 * budget, ήταν το σχήμα της ίδιας της ριπής (6 wallets σχεδόν ταυτόχρονα).
 *
 * ⚠️ Πείραμα βάσει παρατηρημένης συμπεριφοράς, ΟΧΙ επιβεβαιωμένο από επίσημο GMGN
 * burst-limit doc. Παρακολούθησε τα logs μετά την εφαρμογή — αν το `RATE_LIMIT_EXCEEDED`
 * σταματήσει, επιβεβαιώνεται. Αν συνεχίσει, η αιτία είναι κάτι άλλο.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
