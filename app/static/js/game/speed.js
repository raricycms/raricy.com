(function() {
  var suits = ['♥', '♦', '♠', '♣'];
  var values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var MAX_HAND_SIZE = 4;
  var deck, player1DrawPile, player1Hand, player2DrawPile, player2Hand, buildPile1, buildPile2;
  var gameInProgress = true;
  var player1SelectedCard = null;
  var player2SelectedCard = null;
  var isSpeedAllowed = false;

  var elements = {
    p1Hand: document.getElementById('player1-hand'),
    p2Hand: document.getElementById('player2-hand'),
    p1Draw: document.getElementById('player1-draw'),
    p2Draw: document.getElementById('player2-draw'),
    build1: document.getElementById('build-pile1'),
    build2: document.getElementById('build-pile2'),
    winner: document.getElementById('winner'),
    restartBtn: document.getElementById('restart-button'),
    speedPrompt: document.getElementById('speed-prompt')
  };

  function shuffle(array) {
    for (var i = array.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
    return array;
  }

  function dealCards() {
    deck = [];
    suits.forEach(function(s) {
      values.forEach(function(v) { deck.push({ suit: s, value: v }); });
    });

    var redDeck = shuffle(deck.filter(function(card) { return card.suit === '♥' || card.suit === '♦'; }));
    var blackDeck = shuffle(deck.filter(function(card) { return card.suit === '♠' || card.suit === '♣'; }));

    player1Hand = redDeck.slice(0, MAX_HAND_SIZE);
    player1DrawPile = redDeck.slice(MAX_HAND_SIZE);
    player2Hand = blackDeck.slice(0, MAX_HAND_SIZE);
    player2DrawPile = blackDeck.slice(MAX_HAND_SIZE);

    buildPile1 = [player1DrawPile.pop()];
    buildPile2 = [player2DrawPile.pop()];
  }

  function getCardValue(val) {
    if (val === 'A') return 1;
    if (val === 'J') return 11;
    if (val === 'Q') return 12;
    if (val === 'K') return 13;
    return parseInt(val);
  }

  function isPlayable(card, topOfPile) {
    if (!card || !topOfPile) return false;
    var cardVal = getCardValue(card.value);
    var pileVal = getCardValue(topOfPile.value);
    return Math.abs(cardVal - pileVal) === 1 || (cardVal === 1 && pileVal === 13) || (cardVal === 13 && pileVal === 1);
  }

  function canPlayFromHand(hand, b1, b2) {
    var top1 = b1[b1.length - 1];
    var top2 = b2[b2.length - 1];
    return hand.some(function(card) { return isPlayable(card, top1) || isPlayable(card, top2); });
  }

  function canPlayerAct(hand, drawPile) {
    if (canPlayFromHand(hand, buildPile1, buildPile2)) return true;
    if (hand.length < MAX_HAND_SIZE && drawPile.length > 0) return true;
    return false;
  }

  function checkSpeedCondition() {
    if (!canPlayerAct(player1Hand, player1DrawPile) && !canPlayerAct(player2Hand, player2DrawPile) && gameInProgress) {
      elements.speedPrompt.style.display = 'block';
      isSpeedAllowed = true;
    } else {
      elements.speedPrompt.style.display = 'none';
      isSpeedAllowed = false;
    }
  }

  function createCardElement(card) {
    var color = (card.suit === '♥' || card.suit === '♦') ? 'red' : 'black';
    var cardDiv = document.createElement('div');
    cardDiv.className = 'speed-card speed-card--' + color;
    cardDiv.innerHTML = '<div class="speed-card__value">' + card.value + '</div><div class="speed-card__suit">' + card.suit + '</div>';
    return cardDiv;
  }

  function render() {
    renderHand(player1Hand, elements.p1Hand, 1);
    renderHand(player2Hand, elements.p2Hand, 2);
    renderBuildPile(buildPile1, elements.build1);
    renderBuildPile(buildPile2, elements.build2);
    updateCounts();
    checkWinner();
    checkSpeedCondition();
  }

  function renderHand(hand, handElem, player) {
    handElem.innerHTML = '';
    hand.forEach(function(card, index) {
      var isSelected = false;
      if (player === 1) {
        isSelected = player1SelectedCard && player1SelectedCard.index === index;
      } else {
        isSelected = player2SelectedCard && player2SelectedCard.index === index;
      }
      var cardDiv = createCardElement(card);
      if (isSelected) cardDiv.classList.add('speed-card--selected');
      if (card.isNew) {
        cardDiv.classList.add(player === 1 ? 'speed-card--draw-anim-p1' : 'speed-card--draw-anim-p2');
        delete card.isNew;
      }
      handElem.appendChild(cardDiv);
    });
  }

  function renderBuildPile(buildPile, pileElem, isAnimated) {
    isAnimated = isAnimated || false;
    pileElem.innerHTML = '';
    var topCard = buildPile[buildPile.length - 1];
    if (topCard) {
      pileElem.appendChild(createCardElement(topCard));
      pileElem.classList.remove('speed-pile--empty');
    } else {
      pileElem.classList.add('speed-pile--empty');
    }
    if (isAnimated) {
      pileElem.classList.add('speed-pile--playing');
      setTimeout(function() { pileElem.classList.remove('speed-pile--playing'); }, 300);
    }
  }

  function updateCounts() {
    elements.p1Draw.querySelector('.speed-pile__count').textContent = player1DrawPile.length;
    elements.p2Draw.querySelector('.speed-pile__count').textContent = player2DrawPile.length;
  }

  function drawCard(hand, drawPile) {
    if (drawPile.length > 0 && hand.length < MAX_HAND_SIZE) {
      var newCard = drawPile.pop();
      newCard.isNew = true;
      hand.push(newCard);
    }
  }

  function playSelectedCard(selectionInfo, buildPileNum) {
    if (!selectionInfo) return;
    var player = selectionInfo.player;
    var index = selectionInfo.index;
    var card = selectionInfo.card;
    var targetBuildPile = buildPileNum === 1 ? buildPile1 : buildPile2;
    var hand = player === 1 ? player1Hand : player2Hand;

    if (isPlayable(card, targetBuildPile[targetBuildPile.length - 1])) {
      targetBuildPile.push(hand.splice(index, 1)[0]);
      if (player === 1) { player1SelectedCard = null; }
      else { player2SelectedCard = null; }
      renderBuildPile(targetBuildPile, buildPileNum === 1 ? elements.build1 : elements.build2, true);
      render();
    }
  }

  function flipFromDrawPiles() {
    if (!gameInProgress || !isSpeedAllowed) return;

    if (player1DrawPile.length > 0) {
      buildPile1.push(player1DrawPile.pop());
    } else if (player1Hand.length > 0) {
      var randomIndex = Math.floor(Math.random() * player1Hand.length);
      buildPile1.push(player1Hand.splice(randomIndex, 1)[0]);
      if (player1SelectedCard && player1SelectedCard.index === randomIndex) {
        player1SelectedCard = null;
      }
    }

    if (player2DrawPile.length > 0) {
      buildPile2.push(player2DrawPile.pop());
    } else if (player2Hand.length > 0) {
      var randomIndex2 = Math.floor(Math.random() * player2Hand.length);
      buildPile2.push(player2Hand.splice(randomIndex2, 1)[0]);
      if (player2SelectedCard && player2SelectedCard.index === randomIndex2) {
        player2SelectedCard = null;
      }
    }

    renderBuildPile(buildPile1, elements.build1, true);
    renderBuildPile(buildPile2, elements.build2, true);
    render();
  }

  function checkWinner() {
    if (player1Hand.length === 0 && player1DrawPile.length === 0) {
      elements.winner.textContent = '玩家1 获胜!';
      elements.winner.style.display = 'block';
      gameInProgress = false;
    } else if (player2Hand.length === 0 && player2DrawPile.length === 0) {
      elements.winner.textContent = '玩家2 获胜!';
      elements.winner.style.display = 'block';
      gameInProgress = false;
    }
  }

  function handleKeyDown(e) {
    if (!gameInProgress) return;
    var key = e.key.toLowerCase();
    var p1SelectKeys = ['q','w','e','r'];
    var p2SelectKeys = ['u','i','o','p'];

    var p1Index = p1SelectKeys.indexOf(key);
    if (p1Index !== -1 && p1Index < player1Hand.length) {
      player1SelectedCard = { player: 1, index: p1Index, card: player1Hand[p1Index] };
      render();
      return;
    }

    var p2Index = p2SelectKeys.indexOf(key);
    if (p2Index !== -1 && p2Index < player2Hand.length) {
      player2SelectedCard = { player: 2, index: p2Index, card: player2Hand[p2Index] };
      render();
      return;
    }

    if (key === 's' || key === 'd') { playSelectedCard(player1SelectedCard, key === 's' ? 1 : 2); }
    else if (key === 'k' || key === 'l') { playSelectedCard(player2SelectedCard, key === 'k' ? 1 : 2); }

    if (key === 'a') { drawCard(player1Hand, player1DrawPile); render(); }
    if (key === 'j') { drawCard(player2Hand, player2DrawPile); render(); }
    if (e.code === 'Space') { e.preventDefault(); flipFromDrawPiles(); }
  }

  function startGame() {
    gameInProgress = true;
    isSpeedAllowed = false;
    elements.winner.style.display = 'none';
    player1SelectedCard = null;
    player2SelectedCard = null;
    buildPile1 = [];
    buildPile2 = [];
    dealCards();
    render();
  }

  elements.restartBtn.addEventListener('click', startGame);
  window.addEventListener('keydown', handleKeyDown);

  startGame();
})();
