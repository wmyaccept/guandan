export const SUITS = ["S", "H", "D", "C"];
export const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const RANK_LABEL = {
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
  15: "2",
  16: "小王",
  17: "大王"
};

export const LEVELS = [15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export function levelLabel(rank) {
  return RANK_LABEL[rank] ?? String(rank);
}

export function makeCard(deck, suit, rank) {
  return {
    id: `${deck}-${suit}-${rank}`,
    deck,
    suit,
    rank
  };
}

export function createShoe() {
  const cards = [];
  for (let deck = 0; deck < 2; deck += 1) {
    for (const suit of SUITS) {
      for (let rank = 3; rank <= 15; rank += 1) {
        cards.push(makeCard(deck, suit, rank));
      }
    }
    cards.push(makeCard(deck, "J", 16));
    cards.push(makeCard(deck, "J", 17));
  }
  return cards;
}

export function shuffle(cards, rng = Math.random) {
  const next = cards.slice();
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

export function isJoker(card) {
  return card.rank >= 16;
}

export function isHeartLevel(card, levelRank) {
  return card.suit === "H" && card.rank === levelRank;
}

export function isLevelCard(card, levelRank) {
  return card.rank === levelRank;
}

export function sequenceRank(card) {
  if (card.rank >= 3 && card.rank <= 14) return card.rank;
  return null;
}

// Guandan order from weak to strong: 2, 3..K, A, level card, small joker,
// big joker. The level card is promoted above A; a plain 2 is the weakest.
export function rankValue(rank, levelRank) {
  if (rank === 17) return 18;
  if (rank === 16) return 17;
  if (rank === levelRank) return 16;
  if (rank === 15) return 2;
  return rank;
}

export function pointValue(card, levelRank) {
  return rankValue(card.rank, levelRank);
}

export function compareCards(a, b, levelRank) {
  const diff = pointValue(a, levelRank) - pointValue(b, levelRank);
  if (diff !== 0) return diff;
  if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
  return a.deck - b.deck;
}

export function sortHand(cards, levelRank) {
  return cards.slice().sort((a, b) => compareCards(a, b, levelRank));
}

export function cardLabel(card) {
  if (isJoker(card)) return RANK_LABEL[card.rank];
  return `${SUIT_SYMBOL[card.suit]}${RANK_LABEL[card.rank]}`;
}

export function nextLevel(rank) {
  const index = LEVELS.indexOf(rank);
  if (index < 0 || index === LEVELS.length - 1) return rank;
  return LEVELS[index + 1];
}

export function bumpLevel(rank, steps) {
  const index = LEVELS.indexOf(rank);
  if (index < 0) return rank;
  return LEVELS[Math.min(LEVELS.length - 1, index + steps)];
}
