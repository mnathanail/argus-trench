-- 2026-09-28 — on-demand gate (src/decision/onDemandGate.ts): όταν ένα wallet μας αγοράζει
-- token χωρίς καμία αξιολόγηση gate, το ελέγχουμε εκείνη τη στιγμή (gmgn token info +
-- security) αντί να χάνουμε το σήμα. Αυτές οι αξιολογήσεις γράφονται με δική τους
-- προέλευση, ώστε να μην αναμειγνύονται με τα discovery frames (gated_pool/sample_window)
-- σε καμία ανάλυση pass-rate, και ώστε μια μεταγενέστερη αξιολόγηση του discovery για το
-- ίδιο token να γραφτεί σε ΞΕΧΩΡΙΣΤΟ row (σύγκριση on-demand vs πλήρες gate).
ALTER TABLE decision_log DROP CONSTRAINT chk_decision_log_candidate_source;
ALTER TABLE decision_log
  ADD CONSTRAINT chk_decision_log_candidate_source
    CHECK (candidate_source IN ('gated_pool', 'sample_window', 'on_demand'));
