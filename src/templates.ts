// Starter text for new rule files. The first template is free. The others form the Pro template pack.

export interface RuleTemplate {
	id: string;
	name: string;
	pro: boolean;
	body: string;
}

export const TEMPLATES: RuleTemplate[] = [
	{
		id: 'basic',
		name: 'Basic vault rules',
		pro: false,
		body: `# Rules for agents in this folder

## About this folder
- This folder holds Markdown notes for Obsidian.

## How to work here
- Keep each note in Markdown.
- Keep the YAML front matter at the top of a note.
- Use wikilinks like [[Note name]] for links between notes.
- Ask before you delete or move a note.
`,
	},
	{
		id: 'research',
		name: 'Research notes',
		pro: true,
		body: `# Rules for agents in this research folder

## Sources
- Put each source in its own note, with the title, the author, the year and the link.
- Quote a source word for word, in a block quote, with the page number.
- Do not invent a citation. Write "source unknown" when you cannot find one.

## Notes
- Write one claim per bullet.
- Link each claim to its source note with a wikilink.
- Mark your own ideas with the tag #idea.
`,
	},
	{
		id: 'writing',
		name: 'Writing and drafts',
		pro: true,
		body: `# Rules for agents in this writing folder

## Drafts
- Do not rewrite a whole draft. Suggest changes as a list below the text.
- Keep the voice of the author. Do not add new claims.
- Keep headings and the front matter as they are.

## Style
- Use short sentences and active voice.
- Use the spelling that the draft already uses.
`,
	},
	{
		id: 'daily',
		name: 'Daily notes and journal',
		pro: true,
		body: `# Rules for agents in this journal folder

## Privacy
- Read a journal note only when the user names it.
- Do not copy journal text into other notes.

## Daily notes
- Keep the date format of the file names.
- Add tasks as Markdown check boxes at the end of the note.
`,
	},
	{
		id: 'code',
		name: 'Code inside the vault',
		pro: true,
		body: `# Rules for agents in this code folder

## Commands
- Run the tests before you say that a change works.
- Do not install a package without asking.

## Files
- Do not edit files outside this folder.
- Do not commit or push. The user does this.
`,
	},
];

export function templateById(id: string): RuleTemplate {
	return TEMPLATES.find(t => t.id === id) ?? TEMPLATES[0]!;
}
