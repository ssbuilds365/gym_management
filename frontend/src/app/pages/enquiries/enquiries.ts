import {
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize, forkJoin } from 'rxjs';
import { EnquiryRecord, EnquiryService, EnquiryStatus } from '../../services/enquiry';
import { MembershipPlanService } from '../../services/membership-plan';
import { ManagementService } from '../../services/management';

@Component({
  selector: 'app-enquiries',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './enquiries.html',
  styleUrl: './enquiries.scss'
})
export class Enquiries implements OnInit, OnChanges {
  @Input() active = false;
  @Input() memberConversionSubmission: any = null;
  @Output() memberRegistrationRequested = new EventEmitter<any>();
  @Output() memberConversionCompleted = new EventEmitter<any>();

  readonly statuses: EnquiryStatus[] = [
    'NEW', 'CONTACTED', 'INTERESTED', 'TRIAL_SCHEDULED', 'FOLLOW_UP', 'CONVERTED', 'LOST'
  ];
  readonly statusLabels: Record<EnquiryStatus, string> = {
    NEW: 'New',
    CONTACTED: 'Contacted',
    INTERESTED: 'Interested',
    TRIAL_SCHEDULED: 'Trial Scheduled',
    FOLLOW_UP: 'Follow-up',
    CONVERTED: 'Converted',
    LOST: 'Lost'
  };
  readonly sources = ['Walk-in', 'Instagram', 'Facebook', 'WhatsApp', 'Website', 'Referral', 'Google', 'Other'];
  readonly interests = ['Gym Membership', 'Personal Training', 'Both'];
  readonly trialStatuses = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];
  readonly trialStatusLabels: Record<string, string> = {
    SCHEDULED: 'Scheduled',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
    NO_SHOW: 'No show'
  };
  readonly pageSizes = [10, 25, 50];
  enquiries: EnquiryRecord[] = [];
  selectedEnquiry: EnquiryRecord | null = null;
  dashboard: any = null;
  analyticsData: any = null;
  plans: any[] = [];
  staff: any[] = [];
  mode: 'list' | 'analytics' = 'list';
  loading = false;
  dashboardLoading = false;
  analyticsLoading = false;
  saving = false;
  deletingId = '';
  errorMessage = '';
  dashboardError = '';
  analyticsError = '';
  referencesError = '';
  successMessage = '';
  duplicateMessage = '';
  duplicateEnquiryId = '';
  search = '';
  statusFilter = '';
  sourceFilter = '';
  assignedStaffFilter = '';
  fromDate = '';
  toDate = '';
  page = 1;
  limit = 10;
  total = 0;
  totalPages = 0;
  showForm = false;
  editingId = '';
  showFollowUpForm = false;
  showTrialForm = false;
  conversionLoading = false;
  private conversionRequestId = '';
  private conversionSubscriptionActive = false;
  private lastCompletedConversionRequestId = '';
  private lastConversionAttemptId = '';
  enquiryForm: any = this.emptyEnquiry();
  followUpForm: any = this.emptyFollowUp();
  trialForm: any = this.emptyTrial();

  constructor(
    private readonly service: EnquiryService,
    private readonly planService: MembershipPlanService,
    private readonly managementService: ManagementService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadList();
    this.loadDashboard();
    this.loadReferences();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['active']?.currentValue && !changes['active'].firstChange) {
      this.loadList();
      this.loadDashboard();
    }
    const submission = changes['memberConversionSubmission']?.currentValue;
    if (submission) this.completeConversion(submission);
  }

  private emptyEnquiry(): any {
    return {
      fullName: '', phone: '', email: '', gender: '', age: null,
      interestedIn: '', source: '', planId: '', assignedStaffId: '',
      expectedJoiningDate: '', nextFollowUpAt: '', notes: ''
    };
  }

  private emptyFollowUp(): any {
    return { date: '', time: '', outcome: '', notes: '', assignedStaffId: '', nextFollowUpAt: '' };
  }

  private emptyTrial(): any {
    return {
      startDate: '',
      endDate: '',
      status: 'SCHEDULED',
      assignedTrainerId: '',
      feedback: '',
      nextFollowUpAt: '',
      notes: ''
    };
  }

  private loadReferences(): void {
    this.referencesError = '';
    forkJoin({
      plans: this.planService.getPlans(),
      staff: this.managementService.getStaff({ status: 'Active', limit: 100 })
    }).subscribe({
      next: result => {
        this.plans = (result.plans?.plans || result.plans?.membershipPlans || [])
          .filter((plan: any) => plan.status === 'Active');
        this.staff = result.staff?.staff || [];
        this.changeDetector.markForCheck();
      },
      error: () => {
        this.plans = [];
        this.staff = [];
        this.referencesError = 'Membership plans or staff could not be loaded. Refresh and retry before assigning them.';
      }
    });
  }

  private refreshAfterMutation(): void {
    this.loadDashboard();
    this.analyticsData = null;
  }

  loadList(): void {
    this.loading = true;
    this.errorMessage = '';
    this.service.list({
      search: this.search.trim(),
      status: this.statusFilter,
      source: this.sourceFilter,
      assignedStaffId: this.assignedStaffFilter,
      from: this.fromDate,
      to: this.toDate,
      page: this.page,
      limit: this.limit
    }).pipe(finalize(() => {
      this.loading = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => {
        this.enquiries = (response.enquiries || response.data || []).map((item: any) => ({
          ...item,
          status: this.normalizeStatus(item.status)
        }));
        const pagination = response.pagination || {};
        this.total = Number(pagination.total ?? response.total ?? this.enquiries.length);
        this.totalPages = Number(pagination.totalPages ?? Math.ceil(this.total / this.limit));
        if (this.selectedEnquiry) {
          this.selectedEnquiry = this.enquiries.find(item => item._id === this.selectedEnquiry?._id) || this.selectedEnquiry;
        }
      },
      error: error => {
        this.errorMessage = this.errorText(error, 'Unable to load enquiries.');
      }
    });
  }

  loadDashboard(): void {
    this.dashboardLoading = true;
    this.dashboardError = '';
    this.service.dashboard().pipe(finalize(() => {
      this.dashboardLoading = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => this.dashboard = response.dashboard || response.data || response,
      error: error => this.dashboardError = this.errorText(error, 'Unable to load enquiry dashboard.')
    });
  }

  openAnalytics(): void {
    this.mode = 'analytics';
    if (this.analyticsData) return;
    this.analyticsLoading = true;
    this.analyticsError = '';
    this.service.analytics({ from: this.fromDate, to: this.toDate }).pipe(finalize(() => {
      this.analyticsLoading = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => this.analyticsData = response.analytics || response.data || response,
      error: error => this.analyticsError = this.errorText(error, 'Unable to load enquiry analytics.')
    });
  }

  openList(): void {
    this.mode = 'list';
    this.loadList();
  }

  applyFilters(): void {
    this.page = 1;
    this.loadList();
  }

  changePage(nextPage: number): void {
    if (nextPage < 1 || (this.totalPages && nextPage > this.totalPages)) return;
    this.page = nextPage;
    this.loadList();
  }

  openCreateForm(): void {
    this.editingId = '';
    this.enquiryForm = this.emptyEnquiry();
    this.duplicateMessage = '';
    this.duplicateEnquiryId = '';
    this.showForm = true;
  }

  openEditForm(enquiry: EnquiryRecord): void {
    this.editingId = enquiry._id;
    this.enquiryForm = {
      fullName: enquiry.fullName || '',
      phone: enquiry.phone || '',
      email: enquiry.email || '',
      gender: enquiry.gender || '',
      source: enquiry.source || '',
      age: enquiry.age ?? null,
      interestedIn: enquiry.interestedIn || '',
      planId: this.referenceId(enquiry.planId),
      assignedStaffId: this.referenceId(enquiry.assignedStaffId),
      expectedJoiningDate: enquiry.expectedJoiningDate ? this.dateInput(enquiry.expectedJoiningDate) : '',
      nextFollowUpAt: enquiry.nextFollowUpAt ? this.dateTimeInput(enquiry.nextFollowUpAt) : '',
      notes: enquiry.notes || ''
    };
    this.duplicateMessage = '';
    this.duplicateEnquiryId = '';
    this.showForm = true;
  }

  closeForm(): void {
    this.showForm = false;
    this.duplicateMessage = '';
    this.duplicateEnquiryId = '';
  }

  viewDuplicateEnquiry(): void {
    if (!this.duplicateEnquiryId) return;
    const existing = this.enquiries.find(item => item._id === this.duplicateEnquiryId);
    this.closeForm();
    if (existing) {
      this.selectEnquiry(existing);
      return;
    }
    this.service.get(this.duplicateEnquiryId).subscribe({
      next: response => this.selectedEnquiry = response.enquiry || response.data || response,
      error: error => this.errorMessage = this.errorText(error, 'Unable to load the existing enquiry.')
    });
  }

  saveEnquiry(): void {
    if (!this.enquiryForm.fullName.trim() || !this.enquiryForm.phone.trim()) {
      this.errorMessage = 'Name and mobile number are required.';
      return;
    }
    this.saving = true;
    this.errorMessage = '';
    this.duplicateMessage = '';
    this.duplicateEnquiryId = '';
    const payload = {
      ...this.enquiryForm,
      age: this.enquiryForm.age === '' ? null : this.enquiryForm.age,
      planId: this.enquiryForm.planId || null,
      assignedStaffId: this.enquiryForm.assignedStaffId || null,
      expectedJoiningDate: this.enquiryForm.expectedJoiningDate || null,
      nextFollowUpAt: this.enquiryForm.nextFollowUpAt || null
    };
    const request = this.editingId
      ? this.service.update(this.editingId, payload)
      : this.service.create(payload);
    request.pipe(finalize(() => {
      this.saving = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => {
        this.successMessage = response.message || (this.editingId ? 'Enquiry updated.' : 'Enquiry created.');
        this.closeForm();
        this.loadList();
        this.refreshAfterMutation();
      },
      error: error => {
        const message = this.errorText(error, 'Unable to save enquiry.');
        if (error.status === 409 || /duplicate|already exists/i.test(message)) {
          this.duplicateMessage = message;
          this.duplicateEnquiryId = error.error?.existingEnquiryId || error.error?.enquiry?._id || '';
        }
        else this.errorMessage = message;
      }
    });
  }

  selectEnquiry(enquiry: EnquiryRecord): void {
    this.selectedEnquiry = enquiry;
    this.errorMessage = '';
    forkJoin({
      details: this.service.get(enquiry._id),
      history: this.service.statusHistory(enquiry._id),
      followUps: this.service.followUps(enquiry._id),
      trials: this.service.trials(enquiry._id)
    }).subscribe({
      next: result => this.selectedEnquiry = {
        ...(result.details.enquiry || result.details.data || result.details),
        status: this.normalizeStatus((result.details.enquiry || result.details.data || result.details).status),
        statusHistory: result.history.history || [],
        followUps: result.followUps.followUps || [],
        trials: result.trials.trials || []
      },
      error: error => this.errorMessage = this.errorText(error, 'Unable to load enquiry details.')
    });
  }

  updateStatus(enquiry: EnquiryRecord, status: EnquiryStatus): void {
    if (this.normalizeStatus(enquiry.status) === 'CONVERTED') return;
    this.service.updateStatus(enquiry._id, status).subscribe({
      next: response => {
        const updated = { ...(response.enquiry || response.data || { ...enquiry, status }), status };
        this.enquiries = this.enquiries.map(item => item._id === enquiry._id ? updated : item);
        this.selectedEnquiry = updated;
        this.successMessage = response.message || 'Enquiry status updated.';
        this.refreshAfterMutation();
      },
      error: error => this.errorMessage = this.errorText(error, 'Unable to update enquiry status.')
    });
  }

  deleteEnquiry(enquiry: EnquiryRecord): void {
    if (!window.confirm(`Delete the enquiry for ${enquiry.fullName}? This cannot be undone.`)) return;
    this.deletingId = enquiry._id;
    this.service.delete(enquiry._id).pipe(finalize(() => {
      this.deletingId = '';
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => {
        this.successMessage = response.message || 'Enquiry deleted.';
        this.enquiries = this.enquiries.filter(item => item._id !== enquiry._id);
        if (this.selectedEnquiry?._id === enquiry._id) this.selectedEnquiry = null;
        this.refreshAfterMutation();
        this.loadList();
      },
      error: error => this.errorMessage = this.errorText(error, 'Unable to delete enquiry.')
    });
  }

  openFollowUpForm(): void {
    this.followUpForm = this.emptyFollowUp();
    this.showFollowUpForm = true;
  }

  saveFollowUp(): void {
    if (!this.selectedEnquiry) return;
    if (!this.followUpForm.date) {
      this.errorMessage = 'Follow-up date is required.';
      return;
    }
    this.saving = true;
    this.service.addFollowUp(this.selectedEnquiry._id, this.followUpForm).pipe(finalize(() => {
      this.saving = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => {
        this.successMessage = response.message || 'Follow-up recorded.';
        this.showFollowUpForm = false;
        this.selectEnquiry(this.selectedEnquiry!);
        this.loadList();
        this.refreshAfterMutation();
      },
      error: error => this.errorMessage = this.errorText(error, 'Unable to record follow-up.')
    });
  }

  openTrialForm(): void {
    this.trialForm = this.emptyTrial();
    this.showTrialForm = true;
  }

  saveTrial(): void {
    if (!this.selectedEnquiry) return;
    if (!this.trialForm.startDate) {
      this.errorMessage = 'Trial start date and time are required.';
      return;
    }
    this.saving = true;
    this.service.addTrial(this.selectedEnquiry._id, this.trialForm).pipe(finalize(() => {
      this.saving = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => {
        this.successMessage = response.message || 'Trial session scheduled.';
        this.showTrialForm = false;
        this.selectEnquiry(this.selectedEnquiry!);
        this.loadList();
        this.refreshAfterMutation();
      },
      error: error => this.errorMessage = this.errorText(error, 'Unable to schedule trial.')
    });
  }

  startConversion(enquiry: EnquiryRecord): void {
    if (this.conversionLoading) return;
    this.conversionRequestId = `${enquiry._id}-${Date.now()}`;
    this.selectedEnquiry = enquiry;
    this.memberRegistrationRequested.emit({
      requestId: this.conversionRequestId,
      enquiryId: enquiry._id,
      enquiry: {
        fullName: enquiry.fullName,
        phone: enquiry.phone,
        email: enquiry.email || '',
        gender: enquiry.gender || 'Other',
        age: enquiry.age ?? null,
        planId: this.referenceId(enquiry.planId),
        expectedJoiningDate: enquiry.expectedJoiningDate || '',
        notes: enquiry.notes || ''
      }
    });
  }

  private completeConversion(submission: any): void {
    if (
      !submission?.requestId ||
      submission.requestId !== this.conversionRequestId ||
      submission.attemptId === this.lastConversionAttemptId ||
      submission.requestId === this.lastCompletedConversionRequestId ||
      this.conversionSubscriptionActive
    ) return;
    const enquiry = this.selectedEnquiry;
    if (!enquiry || enquiry._id !== submission.enquiryId) return;
    this.lastConversionAttemptId = submission.attemptId;
    this.conversionSubscriptionActive = true;
    this.conversionLoading = true;
    this.service.convert(enquiry._id, submission.payload).pipe(finalize(() => {
      this.conversionLoading = false;
      this.conversionSubscriptionActive = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => {
        this.lastCompletedConversionRequestId = submission.requestId;
        this.conversionRequestId = '';
        this.successMessage = response.message || `${enquiry.fullName} was converted to a member.`;
        this.memberConversionCompleted.emit({
          requestId: submission.requestId,
          attemptId: submission.attemptId,
          member: response.member,
          message: response.message,
          planId: submission.planId || '',
          membershipStartDate: submission.membershipStartDate || ''
        });
        this.selectedEnquiry = { ...(response.enquiry || enquiry), status: 'CONVERTED' };
        this.loadList();
        this.refreshAfterMutation();
      },
      error: error => {
        this.errorMessage = this.errorText(error, 'Unable to convert enquiry. Review the form and retry.');
        this.memberConversionCompleted.emit({
          requestId: submission.requestId,
          attemptId: submission.attemptId,
          error: this.errorMessage
        });
      }
    });
  }

  whatsappUrl(enquiry: EnquiryRecord): string {
    const phone = this.normalizedPhone(enquiry.phone);
    if (!phone) return '';
    const salutation = /^female$/i.test(enquiry.gender || '')
      ? ' Ma\'am'
      : /^male$/i.test(enquiry.gender || '') ? ' Sir' : '';
    const message = `Hello ${enquiry.fullName}${salutation},\n\nThank you for enquiring about our gym membership!\n\nWe received your enquiry and would be happy to assist you with our membership plans and fitness services.\n\nCould you please let us know a convenient time when we can call you to discuss the details?\n\nWe look forward to helping you.\n\nRegards,\nTeam SS Builds`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  }

  phoneUrl(phone: string): string {
    const normalized = this.normalizedPhone(phone);
    return normalized ? `tel:+${normalized}` : '';
  }

  private normalizedPhone(phone: string): string {
    let digits = String(phone || '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 13 && digits.startsWith('910')) digits = digits.slice(3);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (digits.length !== 10) return '';
    return `91${digits}`;
  }

  metric(key: string): any {
    const status = this.dashboard?.statusCounts || {};
    if (key === 'total') return this.dashboard?.total ?? 0;
    if (key === 'conversionRate') return `${this.dashboard?.conversionRate ?? 0}%`;
    if (key === 'followUpsToday') return this.dashboard?.followUpsToday ?? 0;
    if (key === 'overdueFollowUps') return this.dashboard?.overdueFollowUps ?? 0;
    return status[key] ?? status[this.statusLabels[key as EnquiryStatus]] ?? 0;
  }

  chartRows(key: string): Array<{ label: string; value: number }> {
    if (key === 'convertedBySource' || key === 'lostBySource') {
      const field = key === 'convertedBySource' ? 'converted' : 'lost';
      return (this.analyticsData?.sources || []).map((row: any) => ({
        label: String(row._id || 'Unknown'),
        value: Number(row[field] || 0)
      }));
    }
    if (key === 'conversionOutcomes') {
      const statuses = this.analyticsData?.statuses || [];
      return ['CONVERTED', 'LOST'].map(status => {
        const row = statuses.find((item: any) => this.normalizeStatus(item._id || item.status) === status);
        return { label: this.statusLabels[status as EnquiryStatus], value: Number(row?.count || 0) };
      });
    }
    const aliases: Record<string, string[]> = {
      statuses: ['statuses'],
      sources: ['sources'],
      monthly: ['monthly'],
      staff: ['staff', 'byStaff']
    };
    const rows = (aliases[key] || [key])
      .map(candidate => this.analyticsData?.[candidate])
      .find(value => value !== undefined && value !== null) || [];
    const entries = Array.isArray(rows) ? rows : Object.entries(rows)
      .map(([label, value]) => typeof value === 'object' && value !== null
        ? { label, ...value }
        : { label, value });
    return entries.map((row: any) => ({
      label: String(row.label || row.name || row.month || row._id || row.source || row.status || '—'),
      value: Number(row.count ?? row.total ?? row.converted ?? row.value ?? 0)
    }));
  }

  barWidth(key: string, value: number): number {
    const largest = Math.max(0, ...this.chartRows(key).map(row => row.value));
    return largest ? Math.max(3, value / largest * 100) : 0;
  }

  private errorText(error: any, fallback: string): string {
    return error?.error?.message || error?.message || fallback;
  }

  statusLabel(status?: string): string {
    const canonical = this.normalizeStatus(status);
    return this.statusLabels[canonical];
  }

  referenceName(reference: any): string {
    if (!reference) return '';
    if (typeof reference === 'string') {
      const plan = this.plans.find(item => item._id === reference);
      const person = this.staff.find(item => item._id === reference);
      return plan?.planName || person?.fullName || person?.name || '';
    }
    return reference.planName || reference.fullName || reference.name || '';
  }

  private normalizeStatus(status?: string): EnquiryStatus {
    const normalized = String(status || 'NEW').trim().toUpperCase().replace(/[\s-]+/g, '_');
    const aliases: Record<string, EnquiryStatus> = {
      NEW: 'NEW',
      CONTACTED: 'CONTACTED',
      INTERESTED: 'INTERESTED',
      QUALIFIED: 'INTERESTED',
      TRIAL_SCHEDULED: 'TRIAL_SCHEDULED',
      FOLLOW_UP: 'FOLLOW_UP',
      CONVERTED: 'CONVERTED',
      LOST: 'LOST',
      'NOT_INTERESTED': 'LOST'
    };
    return aliases[normalized] || 'NEW';
  }

  private referenceId(value: any): string {
    return typeof value === 'string' ? value : value?._id || '';
  }

  private dateInput(value: string): string {
    return new Date(value).toISOString().slice(0, 10);
  }

  private dateTimeInput(value: string): string {
    const date = new Date(value);
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return localDate.toISOString().slice(0, 16);
  }
}
