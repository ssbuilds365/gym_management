import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PersonalTrainerService } from '../../services/personal-trainer';

@Component({
  selector: 'app-personal-trainer-notes',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './personal-trainer-notes.html',
  styleUrl: './personal-trainer-notes.scss'
})
export class PersonalTrainerNotes implements OnInit {
  notes: any[] = [];
  search = '';
  editingId = '';
  form = { title: '', content: '' };
  showForm = false;
  error = '';

  constructor(private readonly service: PersonalTrainerService) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.service.listNotes(this.search).subscribe({
      next: response => this.notes = response?.notes || [],
      error: error => this.error = error.error?.message || 'Unable to load notes'
    });
  }

  save(): void {
    const request = this.editingId
      ? this.service.updateNote(this.editingId, this.form)
      : this.service.createNote(this.form);
    request.subscribe({
      next: () => { this.cancel(); this.load(); },
      error: error => this.error = error.error?.message || 'Unable to save note'
    });
  }

  edit(note: any): void {
    this.editingId = note._id;
    this.form = { title: note.title, content: note.content };
    this.showForm = true;
  }

  delete(note: any): void {
    if (!window.confirm('Delete this note permanently?')) return;
    this.service.deleteNote(note._id).subscribe({
      next: () => this.load(),
      error: error => this.error = error.error?.message || 'Unable to delete note'
    });
  }

  cancel(): void {
    this.editingId = '';
    this.form = { title: '', content: '' };
    this.showForm = false;
  }
}
