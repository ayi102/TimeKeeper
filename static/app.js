// Live clock in the top bar
function tick() {
  const el = document.getElementById('liveClock');
  if (!el) return;
  const now = new Date();
  let h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  el.textContent = `${h}:${m} ${ampm}`;
}
setInterval(tick, 1000);
tick();

let current = null; // { id, name, clockedIn }

function openWorker(btn) {
  current = {
    id: btn.dataset.id,
    name: btn.dataset.name,
    clockedIn: btn.classList.contains('is-in'),
  };
  document.getElementById('sheetName').textContent = current.name;
  document.getElementById('sheetStatus').textContent =
    current.clockedIn ? 'Currently clocked IN' : 'Currently clocked OUT';

  const action = document.getElementById('actionBtn');
  action.textContent = current.clockedIn ? 'Clock Out' : 'Clock In';
  action.className = 'bigbtn ' + (current.clockedIn ? 'out' : 'in');
  action.disabled = false;

  document.getElementById('stageAction').hidden = false;
  document.getElementById('stageDone').hidden = true;
  document.getElementById('overlay').hidden = false;
}

function closeOverlay() {
  document.getElementById('overlay').hidden = true;
  current = null;
}

async function doClock() {
  if (!current) return;
  const btn = document.getElementById('actionBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/clock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: current.id }),
    });
    if (!res.ok) throw new Error('request failed');
    const data = await res.json();

    const icon = document.getElementById('doneIcon');
    const msg = document.getElementById('doneMsg');
    document.getElementById('stageAction').hidden = true;
    document.getElementById('stageDone').hidden = false;

    if (data.ok) {
      icon.textContent = '✓';
      icon.className = 'checkmark';
      msg.textContent = `${data.name} clocked ${data.action.toUpperCase()} at ${data.time}`;
      // Reload so the name tiles reflect the new state.
      setTimeout(() => location.reload(), 1800);
    } else {
      // Not allowed (too early, off today, shift ended, ...).
      icon.textContent = '✕';
      icon.className = 'checkmark err';
      msg.textContent = data.message;
      setTimeout(closeOverlay, 3200);
    }
  } catch (e) {
    btn.disabled = false;
    alert('Something went wrong. Please try again.');
  }
}

// Refresh the board periodically when idle so auto clock-outs and other
// changes show up without anyone touching the screen.
setInterval(() => {
  if (document.getElementById('overlay').hidden) location.reload();
}, 60000);

// Tap outside the sheet to dismiss.
document.getElementById('overlay').addEventListener('click', (e) => {
  if (e.target.id === 'overlay') closeOverlay();
});
