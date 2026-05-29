import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, moment } from 'obsidian';

interface MyDailyNotesSettings {
	dailyNotesFolder: string;
	dateFormat: string;
	templateFile: string;
}

const DEFAULT_SETTINGS: MyDailyNotesSettings = {
	dailyNotesFolder: 'Daily Notes',
	dateFormat: 'YYYY-MM-DD dddd',
	templateFile: '',
}

export default class MyDailyNotes extends Plugin {
	settings: MyDailyNotesSettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('calendar', 'Open daily note (Shift+click for tomorrow)', (evt: MouseEvent) => {
			const date = evt.shiftKey ? moment().add(1, 'day') : moment();
			this.openDailyNote(date);
		});

		this.addCommand({
			id: 'open-daily-note',
			name: 'Open daily note',
			callback: () => {
				this.openDailyNote(moment());
			}
		});

		this.addSettingTab(new MyDailyNotesSettingTab(this.app, this));

		// When a new daily note is created, apply the template (if empty) and archive old notes
		this.registerEvent(
			this.app.vault.on('create', async (file) => {
				if (!(file instanceof TFile)) return;
				const folderPath = normalizePath(this.settings.dailyNotesFolder);
				if (!file.path.startsWith(folderPath + '/')) return;
				if (!file.path.endsWith('.md')) return;

				const date = this.parseDateFromPath(file.path);
				if (!date) return;

				// Small delay to let Obsidian finish writing the file
				await new Promise(r => setTimeout(r, 100));

				const content = await this.app.vault.read(file);
				if (content.length === 0) {
					const rendered = await this.renderTemplate(date);
					if (rendered) {
						await this.app.vault.modify(file, rendered);
					}
				}

				await this.archiveOldNotes();
			})
		);
	}

	onunload() {}

	parseDateFromPath(path: string): moment.Moment | null {
		const folderPath = normalizePath(this.settings.dailyNotesFolder);
		const basename = path.slice(folderPath.length + 1).replace(/\.md$/, '');
		const date = moment(basename, this.settings.dateFormat, true);
		return date.isValid() ? date : null;
	}

	getDailyNotePath(date: moment.Moment): string {
		const filename = date.format(this.settings.dateFormat);
		return normalizePath(`${this.settings.dailyNotesFolder}/${filename}.md`);
	}

	async openDailyNote(date: moment.Moment) {
		const path = this.getDailyNotePath(date);
		let file = this.app.vault.getAbstractFileByPath(path);

		if (!file) {
			const folderPath = normalizePath(this.settings.dailyNotesFolder);
			if (!this.app.vault.getAbstractFileByPath(folderPath)) {
				await this.app.vault.createFolder(folderPath);
			}
			const content = await this.renderTemplate(date);
			file = await this.app.vault.create(path, content);
			new Notice(`Created ${path}`);
		}

		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
		}
	}

	async renderTemplate(date: moment.Moment): Promise<string> {
		const { templateFile } = this.settings;
		if (!templateFile) return '';

		const templatePath = normalizePath(templateFile.endsWith('.md') ? templateFile : `${templateFile}.md`);
		const file = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(file instanceof TFile)) return '';

		let content = await this.app.vault.read(file);

		// Replace {{date}} and {{date:FORMAT}} variables
		content = content.replace(/\{\{date(?::([^}]+))?\}\}/g, (_match, format) => {
			return date.format(format || this.settings.dateFormat);
		});

		// Replace {{yesterday}}, {{yesterday-link}}, {{tomorrow}}, {{tomorrow-link}} variables
		content = content.replace(/\{\{yesterday(?::([^}]+))?\}\}/g, (_match, format) => {
			return moment(date).subtract(1, 'day').format(format || this.settings.dateFormat);
		});
		content = content.replace(/\{\{yesterday-link(?::([^}]+))?\}\}/g, (_match, format) => {
			const name = moment(date).subtract(1, 'day').format(format || this.settings.dateFormat);
			return `${this.settings.dailyNotesFolder}/${name}`;
		});
		content = content.replace(/\{\{tomorrow(?::([^}]+))?\}\}/g, (_match, format) => {
			return moment(date).add(1, 'day').format(format || this.settings.dateFormat);
		});
		content = content.replace(/\{\{tomorrow-link(?::([^}]+))?\}\}/g, (_match, format) => {
			const name = moment(date).add(1, 'day').format(format || this.settings.dateFormat);
			return `${this.settings.dailyNotesFolder}/${name}`;
		});

		// Replace {{unfinished-tasks}} with unchecked tasks from the previous daily note
		if (content.includes('{{unfinished-tasks}}')) {
			const tasks = await this.getUnfinishedTasks(date);
			content = content.replace(/\{\{unfinished-tasks\}\}/g, tasks);
		}

		return content;
	}

	async archiveOldNotes() {
		const folderPath = normalizePath(this.settings.dailyNotesFolder);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return;

		const currentMonthStart = moment().startOf('month');

		// Snapshot children since we mutate the folder while iterating
		const children = [...folder.children];
		for (const child of children) {
			if (!(child instanceof TFile) || !child.path.endsWith('.md')) continue;
			const childDate = this.parseDateFromPath(child.path);
			if (!childDate) continue;
			if (!childDate.isBefore(currentMonthStart)) continue;

			const archiveFolderName = childDate.format('YYYY-MM MMMM');
			const archiveFolderPath = normalizePath(`${folderPath}/${archiveFolderName}`);
			if (!this.app.vault.getAbstractFileByPath(archiveFolderPath)) {
				await this.app.vault.createFolder(archiveFolderPath);
			}

			const newPath = normalizePath(`${archiveFolderPath}/${child.name}`);
			if (this.app.vault.getAbstractFileByPath(newPath)) continue;

			try {
				await this.app.fileManager.renameFile(child, newPath);
			} catch (e) {
				console.error(`Failed to archive ${child.path}:`, e);
			}
		}
	}

	async getUnfinishedTasks(date: moment.Moment): Promise<string> {
		// Find the most recent daily note before the given date
		const folderPath = normalizePath(this.settings.dailyNotesFolder);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return '';

		let mostRecentFile: TFile | null = null;
		let mostRecentDate: moment.Moment | null = null;

		for (const child of folder.children) {
			if (!(child instanceof TFile) || !child.path.endsWith('.md')) continue;
			const childDate = this.parseDateFromPath(child.path);
			if (!childDate || !childDate.isBefore(date, 'day')) continue;
			if (!mostRecentDate || childDate.isAfter(mostRecentDate, 'day')) {
				mostRecentDate = childDate;
				mostRecentFile = child;
			}
		}

		if (!mostRecentFile) return '';

		const content = await this.app.vault.read(mostRecentFile);
		const lines = content.split('\n');
		const unchecked = lines.filter(line => /^\s*- \[ \] /.test(line));
		return unchecked.join('\n');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class MyDailyNotesSettingTab extends PluginSettingTab {
	plugin: MyDailyNotes;

	constructor(app: App, plugin: MyDailyNotes) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Daily notes folder')
			.setDesc('Folder where daily notes are stored.')
			.addText(text => text
				.setPlaceholder('Daily Notes')
				.setValue(this.plugin.settings.dailyNotesFolder)
				.onChange(async (value) => {
					this.plugin.settings.dailyNotesFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Date format')
			.setDesc('Format for the daily note filename (Moment.js format).')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD')
				.setValue(this.plugin.settings.dateFormat)
				.onChange(async (value) => {
					this.plugin.settings.dateFormat = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Template file')
			.setDesc('Path to the template file (e.g. Templates/Daily). Supports {{date}}, {{date:FORMAT}}, {{yesterday}}, {{tomorrow}}, and {{unfinished-tasks}}.')
			.addText(text => text
				.setPlaceholder('Templates/Daily')
				.setValue(this.plugin.settings.templateFile)
				.onChange(async (value) => {
					this.plugin.settings.templateFile = value;
					await this.plugin.saveSettings();
				}));
	}
}
