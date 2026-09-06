/**
 * Timezone-aware scheduling helper — ΟΧΙ σταθερό UTC offset, γιατί η Ελλάδα αλλάζει ώρα
 * (EEST/EET). Ένα σταθερό offset θα έσπαγε δύο φορές τον χρόνο, αθόρυβα, χωρίς κανένα
 * error στα logs — ακριβώς το είδος σιωπηλού bug που μάθαμε να αποφεύγουμε σήμερα.
 *
 * Χρησιμοποιεί `Intl` (ενσωματωμένο στο Node, καμία εξάρτηση) με το πραγματικό IANA
 * tzdata, άρα ξέρει ήδη πότε αλλάζει η ώρα κάθε χρόνο χωρίς να χρειάζεται ενημέρωση.
 */

const ATHENS_TZ = 'Europe/Athens';

function athensDateParts(date: Date): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ATHENS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/**
 * Μετατρέπει μια "τοπική ώρα Αθήνας" (έτος/μήνας/μέρα/ώρα/λεπτό) στο πραγματικό UTC
 * instant που αντιστοιχεί. Standard τεχνική: μάντεψε ότι είναι UTC (λάθος κατά το
 * offset), δες τι τοπική ώρα Αθήνας δείχνει ΠΡΑΓΜΑΤΙΚΑ αυτό το instant, διόρθωσε κατά τη
 * διαφορά. Σωστό ακόμα και γύρω από αλλαγές ώρας, γιατί το offset προκύπτει από το ίδιο
 * το tzdata για τη ΣΥΓΚΕΚΡΙΜΕΝΗ ημερομηνία, όχι από σταθερή υπόθεση.
 */
function athensWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ATHENS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(guess).map((p) => [p.type, p.value]));
  const athensGuess = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const correction = guess.getTime() - athensGuess;
  return new Date(guess.getTime() + correction);
}

/**
 * Πόσα ms μέχρι την επόμενη εμφάνιση της δεδομένης ώρας:λεπτού, ΤΟΠΙΚΗ ώρα Αθήνας. Αν η
 * ώρα-στόχος πέρασε ήδη σήμερα, πάει στην αυριανή Αθηναϊκή μέρα — χρησιμοποιεί μεσημέρι
 * σαν άγκυρα για τον υπολογισμό "αύριο", ώστε να μην μπερδεύεται γύρω από τις 3-4πμ που
 * γίνονται πραγματικά οι αλλαγές ώρας.
 */
export function msUntilNextAthensTime(
  targetHour: number,
  targetMinute: number,
  now: Date = new Date(),
): number {
  let { year, month, day } = athensDateParts(now);
  let candidate = athensWallTimeToUtc(year, month, day, targetHour, targetMinute);

  if (candidate.getTime() <= now.getTime()) {
    const noonToday = athensWallTimeToUtc(year, month, day, 12, 0);
    const roughlyTomorrow = new Date(noonToday.getTime() + 24 * 60 * 60 * 1000);
    ({ year, month, day } = athensDateParts(roughlyTomorrow));
    candidate = athensWallTimeToUtc(year, month, day, targetHour, targetMinute);
  }

  return candidate.getTime() - now.getTime();
}
