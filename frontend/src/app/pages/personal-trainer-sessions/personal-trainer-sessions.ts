import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MemberService } from '../../services/member';
import { PersonalTrainerService } from '../../services/personal-trainer';

@Component({
  selector: 'app-personal-trainer-sessions',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './personal-trainer-sessions.html',
  styleUrl: './personal-trainer-sessions.scss'
})
export class PersonalTrainerSessions implements OnInit {
  sessions: any[] = [];
  clients: any[] = [];
  dateFilter = '';
  statusFilter = '';
  showForm = false;
  editingId = '';
  loading = false;
  error = '';
  success = '';
  form: any = {
    memberId: '', title: 'Personal Training', date: '', startTime: '07:00', endTime: '08:00', notes: ''
  };

  constructor(
    private readonly service: PersonalTrainerService,
    private readonly members: MemberService
  ) {}

  ngOnInit(): void {
    this.load();
    this.members.getMembers('', '', 1, 100).subscribe({
      next: response => this.clients = response?.members || []
    });
  }

  load(): void {
    this.loading = true;
    this.service.listSessions(this.dateFilter, this.statusFilter).subscribe({
      next: response => { this.loading = false; this.sessions = response?.sessions || []; },
      error: error => { this.loading = false; this.error = error.error?.message || 'Unable to load sessions'; }
    });
  }

  save(): void {
    this.error = '';
    this.success = '';
    const request = this.editingId
      ? this.service.updateSession(this.editingId, this.form)
      : this.service.createSession(this.form);
    request.subscribe({
      next: () => {
        this.success = this.editingId ? 'Session updated.' : 'Session created.';
        this.cancel();
        this.load();
      },
      error: error => this.error = error.error?.message || 'Unable to save session'
    });
  }

  edit(session: any): void {
    const start = new Date(session.startAt);
    const end = new Date(session.endAt);
    this.editingId = session._id;
    this.showForm = true;
    this.form = {
      memberId: session.memberId?._id || session.memberId,
      title: session.title,
      date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
      startTime: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
      endTime: `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`,
      notes: session.notes || ''
    };
  }

  delete(session: any): void {
    if (!window.confirm('Delete this session permanently?')) return;
    this.service.deleteSession(session._id).subscribe({
      next: () => { this.success = 'Session deleted.'; this.load(); },
      error: error => this.error = error.error?.message || 'Unable to delete session'
    });
  }

  cancel(): void {
    this.showForm = false;
    this.editingId = '';
  }
}
