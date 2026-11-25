-- One guess per participant per round (prevents double-scoring races).
create unique index if not exists guesses_one_per_round_idx
  on guesses(session_id, participant_id, song_index);
