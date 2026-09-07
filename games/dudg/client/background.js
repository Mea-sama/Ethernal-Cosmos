/* ─── Background particle canvas ────────────────────────────────────────────
   Draws slowly drifting card suits and poker chips on a canvas element.
   Lightweight, no external deps.
────────────────────────────────────────────────────────────────────────── */
(function () {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const SUITS = ['♠', '♥', '♦', '♣', '🂡', '🂱', '🃁', '🂫', /*'(❁´◡`❁)'*/]; // spades, hearts, diamonds, clubs (both black and red versions)
  const COUNT = 28;
  const particles = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function rand(min, max) { return Math.random() * (max - min) + min; }

  function createParticle() {
    let symbol = SUITS[Math.floor(Math.random() * SUITS.length)];
    return {
      x: rand(0, canvas.width),
      y: rand(-50, canvas.height + 50),
      symbol: symbol,
      size: rand(54, 144),
      alpha: rand(0.31, 0.65),
      speedY: rand(0.12, 0.35),
      speedX: rand(-0.08, 0.08),
      rot: rand(0, Math.PI * 2),
      rotSpeed: rand(-0.005, 0.005),
      // red suits get a faint red tint, black stay gold-ish
      color: ['♥', '♦', '🂱', '🃁'].includes(symbol) ? '180,40,40' : '0,0,0',
    };
  }

  // Assign correct color per suit
  function particleColor(p) {
    return ['♥', '♦', '🂱', '🃁'].includes(p.symbol) ? '255,50,50' : /*'90,80,20'*/ '0,0,0';
  }

  function init() {
    resize();
    for (let i = 0; i < COUNT; i++) {
      const p = createParticle();
      if (['🂡', '🂱', '🃁', '🂫'].includes(p.symbol))
        p.size *= 0.8;
      p.y = rand(0, canvas.height); // start distributed
      p.color = particleColor(p);
      particles.push(p);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles.forEach(p => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = `rgb(${p.color})`;
      ctx.font = `${p.size}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.symbol, 0, 0);
      ctx.restore();

      p.y -= p.speedY;
      p.x += p.speedX;
      p.rot += p.rotSpeed;

      if (p.y < -60) {
        p.y = canvas.height + 50;
        p.x = rand(0, canvas.width);
      }
      if (p.x < -60) p.x = canvas.width + 50;
      if (p.x > canvas.width + 60) p.x = -50;
    });

    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  init();
  draw();
})();
