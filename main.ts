import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, moment } from 'obsidian';

interface MyDailyNotesSettings {
	dailyNotesFolder: string;
	dateFormat: string;
}

const DEFAULT_SETTINGS: MyDailyNotesSettings = {
	dailyNotesFolder: 'Daily Notes',
	dateFormat: 'YYYY-MM-DD',
}

export default class MyDailyNotes extends Plugin {
	settings: MyDailyNotesSettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('calendar', 'Open daily note', (evt: MouseEvent) => {
			this.openDailyNote(moment());
		});

		this.addCommand({
			id: 'open-daily-note',
			name: 'Open daily note',
			callback: () => {
				this.openDailyNote(moment());
			}
		});

		this.addSettingTab(new MyDailyNotesSettingTab(this.app, this));
	}

	onunload() {}

	getDailyNotePath(date: moment.Moment): string {
		const filename = date.format(this.settings.dateFormat);
		return normalizePath(`${this.settings.dailyNotesFolder}/${filename}.md`);
	}

	async openDailyNote(date: moment.Moment) {
		const path = this.getDailyNotePath(date);
		let file = this.app.vault.getAbstractFileByPath(path);

		if (!file) {
			// Ensure the folder exists
			const folderPath = normalizePath(this.settings.dailyNotesFolder);
			if (!this.app.vault.getAbstractFileByPath(folderPath)) {
				await this.app.vault.createFolder(folderPath);
			}
			file = await this.app.vault.create(path, '');
			new Notice(`Created ${path}`);
		}

		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
		}
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
	}
}
