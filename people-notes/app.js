import { PeopleStore, KEY } from './store.js';
const $ = id => document.getElementById(id);
// Access itself can throw when browser storage is blocked.
let storage;
try { storage = window.localStorage; } catch { storage = { getItem() { throw new Error('Storage blocked'); } }; }
const store = new PeopleStore(storage);
let editing = null;
let baseline = '';
const draft = () => JSON.stringify(['name', 'location', 'note'].map(id => $(id).value));
const say = message => { $('status').textContent = message; };
function render() {
  $('people').replaceChildren();
  const blocked = !!store.error;
  for (const id of ['add', 'first-add', 'import', 'export']) $(id).disabled = blocked;
  $('load-error').hidden = !blocked;
  $('load-error').textContent = store.error || '';
  $('count').textContent = String(store.people.length);
  if (blocked) { $('empty').hidden = true; return; }
  const query = $('search').value.trim().toLocaleLowerCase();
  const people = store.people.filter(p => [p.name, p.location, p.note].some(v => v.toLocaleLowerCase().includes(query)));
  $('empty').hidden = people.length > 0;
  $('empty').querySelector('h2').textContent = query ? 'No familiar faces here yet.' : 'A familiar face starts here.';
  $('empty').querySelector('p').textContent = query ? 'Try another name, place, or detail.' : 'A name, a place, something to remember. Make a little space for someone.';
  $('first-add').hidden = !!query;
  for (const person of people) {
    const card = document.createElement('button');
    card.className = 'person';
    card.setAttribute('aria-label', `Edit ${person.name}`);
    const top = document.createElement('div'); top.className = 'person-top';
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = person.name.trim().split(/\s+/).slice(0, 2).map(s => Array.from(s)[0]).join('').toLocaleUpperCase();
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
    top.append(avatar, arrow);
    const name = document.createElement('h3'); name.textContent = person.name;
    card.append(top, name);
    if (person.location) { const p = document.createElement('p'); p.className = 'place'; p.textContent = person.location; card.append(p); }
    if (person.note) { const p = document.createElement('p'); p.className = 'note'; p.textContent = person.note; card.append(p); }
    card.addEventListener('click', () => openEditor(person));
    $('people').append(card);
  }
}
function openEditor(person = null) {
  editing = person;
  for (const id of ['name', 'location', 'note']) $(id).value = person?.[id] || '';
  // Existing/imported notes may be longer than new-entry guidance; never truncate them.
  $('editor-title').textContent = person ? 'Edit person' : 'New person';
  $('delete').hidden = !person;
  $('save-error').hidden = true;
  baseline = draft();
  $('editor').showModal();
  $('name').focus();
}
function closeEditor() {
  if (draft() !== baseline && !confirm('Discard your unsaved changes?')) return;
  $('editor').close();
}
function editorError(error) { $('save-error').textContent = error.message; $('save-error').hidden = false; }
function newID() {
  // getRandomValues also works when previewing over local-network HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
$('add').onclick = $('first-add').onclick = () => openEditor();
$('close').onclick = $('cancel').onclick = closeEditor;
$('editor').addEventListener('cancel', e => { e.preventDefault(); closeEditor(); });
$('search').oninput = render;
$('form').onsubmit = e => {
  e.preventDefault();
  const name = $('name').value.trim();
  if (!name) { editorError(new Error('Please enter a name.')); $('name').focus(); return; }
  try {
    store.save({ id: editing?.id || newID(), name, location: $('location').value.trim(), note: $('note').value.trim(), updatedAt: new Date().toISOString() });
    $('editor').close(); render(); say(`${name} saved.`);
  } catch (error) { editorError(error); }
};
$('delete').onclick = () => {
  if (!editing || !confirm(`Delete ${editing.name} and their note? This cannot be undone.`)) return;
  try { store.delete(editing.id); $('editor').close(); render(); say('Person deleted.'); }
  catch (error) { editorError(error); }
};
$('reload').onclick = () => { store.reload(); render(); say(store.error ? 'Notes are still unavailable.' : 'Notes reloaded.'); };
$('export').onclick = () => {
  try {
    const blob = new Blob([store.export()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `people-notes-${new Date().toISOString().slice(0,10)}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    say('Backup prepared. Save the downloaded JSON file in a safe place.');
  } catch (error) { say(error.message); }
};
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0]; if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a backup smaller than 10 MB.');
    const added = store.import(await file.text()); render(); say(`Imported ${added} ${added === 1 ? 'person' : 'people'}. Existing people were kept.`);
  } catch (error) { say(error instanceof SyntaxError ? 'That file is not valid JSON. Nothing was imported.' : error.message); }
  finally { $('file').value = ''; }
};
window.addEventListener('storage', e => {
  if (e.key !== KEY && e.key !== null) return;
  // Keep the snapshot while editing so save detects a conflicting change.
  if ($('editor').open) editorError(new Error('Notes changed in another window. Copy any unsaved text, then close this editor and reload notes.'));
  else { store.reload(); render(); say('Updated from another window.'); }
});
window.addEventListener('beforeunload', e => {
  if ($('editor').open && draft() !== baseline) { e.preventDefault(); e.returnValue = ''; }
});
render();
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready).then(() => {
    $('offline').textContent = 'Offline ready. On iPhone, open Share in Safari and choose Add to Home Screen. Export a backup before switching browsers or devices.';
  }).catch(() => { $('offline').textContent = 'Offline setup was unavailable. You can still use your notes while this page is open.'; });
}
