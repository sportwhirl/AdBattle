export const KEY = 'people-notes.v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validate(value) {
  if (!Array.isArray(value)) throw new Error('Choose a People Notes JSON backup containing a list of people.');
  const ids = new Set();
  return value.map(person => {
    if (!person || !uuid.test(person.id) || ['name', 'location', 'note', 'updatedAt'].some(k => typeof person[k] !== 'string') ||
        !person.name.trim() || !/^\d{4}-\d{2}-\d{2}T/.test(person.updatedAt) || !Number.isFinite(Date.parse(person.updatedAt))) {
      throw new Error('This backup has an invalid person. Nothing was imported.');
    }
    const id = person.id.toLowerCase();
    if (ids.has(id)) throw new Error('This backup has duplicate person identifiers. Nothing was imported.');
    ids.add(id);
    return { id, name: person.name, location: person.location, note: person.note, updatedAt: person.updatedAt };
  });
}

export class PeopleStore {
  constructor(storage) {
    this.storage = storage;
    this.people = [];
    this.error = null;
    this.snapshot = null;
    this.reload();
  }
  reload() {
    try {
      const raw = this.storage.getItem(KEY);
      const people = raw === null ? [] : validate(JSON.parse(raw));
      this.people = people.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      this.snapshot = raw;
      this.error = null;
    } catch {
      this.error = 'Your saved notes could not be read. They have been left untouched. Enable browser storage or restore access, then try again.';
    }
  }
  commit(people) {
    if (this.error) throw new Error(this.error);
    // Prevent a stale tab from silently overwriting changes from another tab.
    if (this.storage.getItem(KEY) !== this.snapshot) {
      throw new Error('Your notes changed in another window. Close this editor and use Reload notes before trying again.');
    }
    const next = validate(people).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const raw = JSON.stringify(next);
    try { this.storage.setItem(KEY, raw); }
    catch { throw new Error('Couldn’t save to this browser. Storage may be full or blocked. Your changes are still here; export a backup or free up space and try again.'); }
    this.people = next;
    this.snapshot = raw;
  }
  save(person) {
    const id = person.id.toLowerCase();
    this.commit([...this.people.filter(p => p.id !== id), { ...person, id }]);
  }
  delete(id) { this.commit(this.people.filter(p => p.id !== id)); }
  import(text) {
    const incoming = validate(JSON.parse(text));
    // Keep existing records with the same ID. Import never replaces edits.
    const existing = new Set(this.people.map(p => p.id));
    const added = incoming.filter(p => !existing.has(p.id));
    this.commit([...this.people, ...added]);
    return added.length;
  }
  export() {
    if (this.error) throw new Error(this.error);
    // Swift's ISO8601 decoder expects dates without fractional seconds.
    return JSON.stringify(this.people.map(p => ({ ...p, updatedAt: new Date(p.updatedAt).toISOString().replace(/\.\d{3}Z$/, 'Z') })), null, 2);
  }
}
