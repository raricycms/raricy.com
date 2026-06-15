/**
 * Gomoku (五子棋) — Game Constants
 * Shared configuration and scoring values used by all modules.
 */
(function() {
  var C = {
    BOARD_SIZE: 15,
    EMPTY: 0,
    BLACK: 1,
    WHITE: 2,

    /** Direction vectors: right, down, down-right, down-left */
    DIRECTIONS: [
      [0, 1],
      [1, 0],
      [1, 1],
      [1, -1]
    ],

    /** Pattern scores — large power-of-10 gaps prevent lower patterns from
     *  outweighing higher threats. */
    SCORE: {
      FIVE:            1000000,  // instant win
      OPEN_FOUR:        100000,  // guaranteed win next move
      CLOSED_FOUR:       10000,  // must be blocked
      OPEN_THREE:         5000,  // can become open four
      CLOSED_THREE:         500,  // limited threat
      OPEN_TWO:             200,
      CLOSED_TWO:            50,
      OPEN_ONE:              10,
      CENTER_WEIGHT:          3   // per-unit proximity bonus
    },

    WIN_LENGTH: 5,

    /** AI search parameters */
    MAX_DEPTH: 4,           // minimax search depth (plies)
    CANDIDATE_WIDTH: 12,    // top-N moves to expand per node
    DEFENSE_WEIGHT: 1.05    // defense multiplier in evaluation
  };

  window.GomokuConstants = C;
})();
