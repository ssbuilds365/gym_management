import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize, Subscription } from 'rxjs';
import { jsPDF } from 'jspdf';
import { ManagementService } from '../../services/management';
import { MembershipPlanService } from '../../services/membership-plan';

interface ReportRecord {
  [key: string]: any;
}

interface ReportColumn {
  key: string;
  label: string;
}

interface ReportOption {
  value: string;
  label: string;
  category: string;
}

const REPORT_OPTIONS: ReportOption[] = [
  { value: 'revenue', label: 'Successful & payment transactions', category: 'Financial' },
  { value: 'pending', label: 'Pending payments', category: 'Financial' },
  { value: 'refunds', label: 'Refunds', category: 'Financial' },
  { value: 'failed', label: 'Failed / cancelled payments', category: 'Financial' },
  { value: 'unpaid', label: 'Unpaid fees', category: 'Financial' },
  { value: 'partial', label: 'Partially paid members', category: 'Financial' },
  { value: 'fullyPaid', label: 'Fully paid members', category: 'Financial' },
  { value: 'gst', label: 'Saved GST invoices', category: 'GST & Tax' },
  { value: 'newMembers', label: 'New members', category: 'Members' },
  { value: 'activeMembers', label: 'Active members', category: 'Members' },
  { value: 'inactiveMembers', label: 'Inactive members', category: 'Members' },
  { value: 'members', label: 'Member payment overview', category: 'Members' },
  { value: 'memberships', label: 'Memberships ending in period', category: 'Memberships' },
  { value: 'expiring', label: 'Upcoming renewals (30 days)', category: 'Memberships' },
  { value: 'renewedMemberships', label: 'Renewed memberships', category: 'Memberships' },
  { value: 'nonRenewedMembers', label: 'Expired / non-renewed memberships', category: 'Memberships' },
  { value: 'expiredMemberships', label: 'Expired memberships', category: 'Memberships' },
  { value: 'attendance', label: 'Attendance history', category: 'Attendance' },
  { value: 'attendanceMembers', label: 'Member attendance frequency', category: 'Attendance' },
  { value: 'trainers', label: 'Trainer workload', category: 'Trainers & Staff' },
  { value: 'staff', label: 'Staff directory', category: 'Trainers & Staff' }
];

const today = (): string => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './reports.html',
  styleUrl: './reports.scss'
})
export class Reports implements OnInit, OnDestroy {
  readonly reportOptions = REPORT_OPTIONS;
  readonly categories = ['Financial', 'Members', 'Memberships', 'Attendance', 'Trainers & Staff', 'GST & Tax'];
  period = 'month';
  from = `${today().slice(0, 7)}-01`;
  to = today();
  readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  loading = false;
  detailLoading = false;
  exporting = false;
  errorMessage = '';
  detailError = '';
  report: any = null;
  reportType = 'revenue';
  search = '';
  paymentStatus = '';
  paymentMethod = '';
  attendanceStatus = '';
  attendanceSource = '';
  teamStatus = '';
  planId = '';
  trainerId = '';
  plans: Array<{ _id: string; planName: string }> = [];
  trainers: Array<{ _id: string; name: string; role: string }> = [];
  detailRecords: ReportRecord[] = [];
  detailTotal = 0;
  detailPage = 1;
  readonly pageSize = 25;
  detailPages = 0;
  sortBy = 'paymentDate';
  sortDirection = 'desc';
  detailSummary: any = null;
  detailColumns: ReportColumn[] = [];
  private latestQuery: Record<string, string | number | boolean | undefined> = {};
  private detailSubscription?: Subscription;
  private detailSearchTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly management: ManagementService,
    private readonly membershipPlans: MembershipPlanService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadPlans();
    this.loadTrainers();
    this.load();
  }

  ngOnDestroy(): void {
    if (this.detailSearchTimer) clearTimeout(this.detailSearchTimer);
    this.detailSubscription?.unsubscribe();
  }

  get reportGroups(): string[] {
    return this.categories;
  }

  get selectedOption(): ReportOption {
    return REPORT_OPTIONS.find(option => option.value === this.reportType) || REPORT_OPTIONS[0];
  }

  get reportTitle(): string {
    return this.selectedOption.label;
  }

  reportOptionsFor(category: string): ReportOption[] {
    return this.reportOptions.filter(option => option.category === category);
  }

  get summaryCards(): Array<{ label: string; value: string | number; note?: string }> {
    const summary = this.report?.summary;
    if (!summary) return [];
    return [
      { label: 'Total Revenue', value: this.money(summary.totalRevenue), note: 'Successful payments in selected period' },
      { label: 'Net Collection', value: this.money(summary.netCollection), note: 'Successful payments less recorded refunds' },
      { label: 'Pending Fees', value: this.money(summary.pendingFees), note: 'Current unpaid membership balances' },
      { label: 'Active Members', value: summary.totalActiveMembers },
      { label: 'New Members', value: summary.newMembers, note: 'Joined in selected period' },
      {
        label: 'Member Retention',
        value: summary.retentionRate == null ? '—' : `${summary.retentionRate.toFixed(1)}%`,
        note: `${summary.retainedMembers} of ${summary.retentionCohort} members active at both period boundaries`
      },
      {
        label: 'Average Attendance',
        value: `${Number(summary.averageAttendancePercentage || 0).toFixed(1)}%`,
        note: 'Average daily visits divided by current active members'
      },
      { label: 'Total Trainers', value: summary.totalTrainers, note: `${summary.activeTrainers} active` },
      { label: 'Total Staff', value: summary.totalStaff, note: `${summary.activeStaff} active` }
    ];
  }

  setPeriod(period: string): void {
    this.period = period;
    const date = new Date();
    const dateString = (value: Date): string =>
      `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    if (period === 'today') this.from = this.to = dateString(date);
    if (period === 'yesterday') {
      const yesterday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
      this.from = this.to = dateString(yesterday);
    }
    if (period === 'week') {
      const mondayOffset = (date.getDay() + 6) % 7;
      this.from = dateString(new Date(date.getFullYear(), date.getMonth(), date.getDate() - mondayOffset));
      this.to = dateString(date);
    }
    if (period === 'month') {
      this.from = dateString(new Date(date.getFullYear(), date.getMonth(), 1));
      this.to = dateString(date);
    }
    if (period === 'lastMonth') {
      this.from = dateString(new Date(date.getFullYear(), date.getMonth() - 1, 1));
      this.to = dateString(new Date(date.getFullYear(), date.getMonth(), 0));
    }
    if (period === 'year') {
      this.from = dateString(new Date(date.getFullYear(), 0, 1));
      this.to = dateString(date);
    }
    this.load();
  }

  load(): void {
    if (!this.from || !this.to || this.from > this.to) {
      this.errorMessage = 'Select a valid date range.';
      return;
    }
    this.loading = true;
    this.errorMessage = '';
    this.management.getReport(this.period === 'custom'
      ? { period: 'custom', from: this.from, to: this.to, timezone: this.timezone }
      : { period: this.period, from: this.from, to: this.to, timezone: this.timezone })
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.report = response;
          this.errorMessage = '';
          this.loadDetails();
        },
        error: error => {
          console.error('Reports overview loading error:', error);
          this.report = null;
          this.errorMessage = error.error?.message || 'Unable to generate reports.';
        }
      });
  }

  loadDetails(): void {
    if (this.detailSearchTimer) {
      clearTimeout(this.detailSearchTimer);
      this.detailSearchTimer = undefined;
    }
    if (!this.from || !this.to || this.from > this.to) {
      this.detailError = 'Select a valid date range.';
      return;
    }
    this.detailSubscription?.unsubscribe();
    this.detailLoading = true;
    this.detailError = '';
    this.detailPage = 1;
    this.latestQuery = this.detailFilters();
    this.detailSubscription = this.management.getReport({
      ...this.latestQuery,
      detailsOnly: true,
      page: this.detailPage,
      limit: this.pageSize
    }).pipe(finalize(() => {
      this.detailLoading = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => this.acceptDetails(response),
      error: error => {
        console.error('Detailed report loading error:', error);
        this.detailRecords = [];
        this.detailSummary = null;
        this.detailError = error.error?.message || 'Unable to load report details.';
      }
    });
  }

  onDetailSearchChange(): void {
    if (this.detailSearchTimer) clearTimeout(this.detailSearchTimer);
    this.detailSubscription?.unsubscribe();
    this.detailSearchTimer = setTimeout(() => {
      this.detailSearchTimer = undefined;
      this.loadDetails();
    }, 300);
  }

  changePage(delta: number): void {
    const page = Math.max(1, Math.min(this.detailPages, this.detailPage + delta));
    if (page === this.detailPage) return;
    this.detailSubscription?.unsubscribe();
    this.detailLoading = true;
    this.detailPage = page;
    this.detailSubscription = this.management.getReport({
      ...this.latestQuery,
      detailsOnly: true,
      page,
      limit: this.pageSize
    }).pipe(finalize(() => {
      this.detailLoading = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: response => this.acceptDetails(response),
      error: error => {
        console.error('Report page loading error:', error);
        this.detailError = error.error?.message || 'Unable to load this report page.';
      }
    });
  }

  sort(field: string): void {
    if (this.sortBy === field) this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    else {
      this.sortBy = field;
      this.sortDirection = 'asc';
    }
    this.loadDetails();
  }

  changeReport(type: string): void {
    this.reportType = type;
    this.paymentStatus = '';
    this.paymentMethod = '';
    this.attendanceStatus = '';
    this.attendanceSource = '';
    this.teamStatus = '';
    this.planId = '';
    this.trainerId = '';
    this.sortBy = ['memberships', 'expiring', 'expiredMemberships', 'renewedMemberships', 'nonRenewedMembers'].includes(type)
      ? 'endDate'
      : type === 'gst'
        ? 'issueDate'
        : type === 'attendanceMembers'
          ? 'visits'
          : type === 'attendance'
            ? 'attendanceDate'
            : ['members', 'newMembers', 'activeMembers', 'inactiveMembers', 'unpaid', 'partial', 'fullyPaid'].includes(type)
              ? 'fullName'
              : ['trainers', 'staff'].includes(type)
                ? 'name'
                : 'paymentDate';
    this.sortDirection = type === 'attendanceMembers' ? 'asc' : 'desc';
    this.loadDetails();
  }

  export(format: 'pdf' | 'excel' | 'csv' | 'print'): void {
    if (this.exporting) return;
    this.exporting = true;
    this.detailError = '';
    const filters = this.detailFilters();
    this.management.getAllReportRows(filters)
      .subscribe({
        next: records => {
          if (format === 'csv') this.exportCsv(records);
          else if (format === 'excel') this.exportExcel(records);
          else if (format === 'pdf') {
            void this.exportPdf(records)
              .catch(error => {
                console.error('PDF report generation error:', error);
                this.detailError = 'Unable to generate the PDF report.';
              })
              .finally(() => {
                this.exporting = false;
                this.changeDetector.markForCheck();
              });
            return;
          }
          else this.printReport(records);
          this.exporting = false;
          this.changeDetector.markForCheck();
        },
        error: error => {
          this.exporting = false;
          console.error('Report export data loading error:', error);
          this.detailError = error.error?.message || 'Unable to load all records for export.';
          this.changeDetector.markForCheck();
        }
      });
  }

  barWidth(value: number, rows: Array<Record<string, any>>, key: string): number {
    const max = Math.max(1, ...rows.map(row => Number(row[key]) || 0));
    return Math.max(value > 0 ? 2 : 0, (Number(value) / max) * 100);
  }

  money(value: number): string {
    return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  getCell(record: ReportRecord, column: ReportColumn): string {
    const raw = column.key.split('.').reduce<any>((current, key) => current?.[key], record);
    if (raw === null || raw === undefined || raw === '') return '—';
    if (Array.isArray(raw)) {
      return raw.map(item => typeof item === 'object'
        ? item.fullName || item.name || JSON.stringify(item)
        : String(item)).join(', ') || '—';
    }
    if (typeof raw === 'object') return JSON.stringify(raw);
    if (typeof raw === 'number' && /amount|price|paid|pending|tax|cgst|sgst|igst|revenue|fees/i.test(column.key)) {
      return this.money(raw);
    }
    if (typeof raw === 'string' && /^\d{4}-\d\d-\d\dT/.test(raw)) {
      return new Date(raw).toLocaleString('en-IN');
    }
    return String(raw);
  }

  getPeriodLabel(): string {
    return this.report?.period
      ? `${this.report.period.from} to ${this.report.period.to} (${this.report.period.timezone})`
      : `${this.from} to ${this.to}`;
  }

  trackByMonth(_index: number, row: { month: string }): string {
    return row.month;
  }

  sourceEntries(sources: Record<string, number> | null | undefined): Array<{ key: string; value: number }> {
    return Object.entries(sources || {}).map(([key, value]) => ({ key, value }));
  }

  private acceptDetails(response: any): void {
    this.detailRecords = response.detail?.records || [];
    this.detailTotal = response.detail?.total || 0;
    this.detailPage = response.detail?.page || 1;
    this.detailPages = response.detail?.totalPages || 0;
    this.detailSummary = response.detail?.summary || { recordCount: this.detailTotal };
    this.detailColumns = this.columnsFor(this.reportType, this.detailRecords);
  }

  private detailFilters(): Record<string, string | number | boolean | undefined> {
    return {
      period: this.period === 'custom' ? 'custom' : this.period,
      from: this.from,
      to: this.to,
      timezone: this.timezone,
      type: this.reportType,
      search: this.search.trim(),
      paymentStatus: this.paymentStatus,
      paymentMethod: this.paymentMethod,
      attendanceStatus: this.attendanceStatus,
      attendanceSource: this.attendanceSource,
      teamStatus: this.teamStatus,
      planId: this.planId,
      trainerId: this.trainerId,
      sortBy: this.sortBy,
      sortDirection: this.sortDirection
    };
  }

  private columnsFor(type: string, records: ReportRecord[]): ReportColumn[] {
    const definitions: Record<string, ReportColumn[]> = {
      revenue: [
        { key: 'paymentDate', label: 'Payment Date' }, { key: 'member._id', label: 'Member ID' },
        { key: 'member.name', label: 'Member' },
        { key: 'member.phone', label: 'Phone' }, { key: 'membership.planName', label: 'Plan' },
        { key: 'amount', label: 'Amount' }, { key: 'paymentMethod', label: 'Method' },
        { key: 'status', label: 'Status' }, { key: 'transactionId', label: 'Transaction ID' }
      ],
      pending: [
        { key: 'paymentDate', label: 'Payment Date' }, { key: 'member._id', label: 'Member ID' },
        { key: 'member.name', label: 'Member' },
        { key: 'member.phone', label: 'Phone' }, { key: 'amount', label: 'Amount' },
        { key: 'paymentMethod', label: 'Method' }, { key: 'status', label: 'Status' }
      ],
      refunds: [
        { key: 'refund.refundedAt', label: 'Refund Date' }, { key: 'member._id', label: 'Member ID' },
        { key: 'member.name', label: 'Member' },
        { key: 'member.phone', label: 'Phone' }, { key: 'refund.amount', label: 'Refund Amount' },
        { key: 'refund.refundReference', label: 'Refund Reference' }, { key: 'refund.reason', label: 'Reason' }
      ],
      failed: [
        { key: 'paymentDate', label: 'Payment Date' }, { key: 'member._id', label: 'Member ID' },
        { key: 'member.name', label: 'Member' },
        { key: 'member.phone', label: 'Phone' }, { key: 'amount', label: 'Amount' },
        { key: 'status', label: 'Status' }, { key: 'transactionId', label: 'Transaction ID' }
      ],
      gst: [
        { key: 'issueDate', label: 'Invoice Date' }, { key: 'invoiceNumber', label: 'Invoice Number' },
        { key: 'member._id', label: 'Member ID' }, { key: 'member.name', label: 'Member' },
        { key: 'membership.planName', label: 'Plan' },
        { key: 'taxableAmount', label: 'Taxable Amount' }, { key: 'cgst', label: 'CGST' },
        { key: 'sgst', label: 'SGST' }, { key: 'igst', label: 'IGST' }, { key: 'totalTax', label: 'Total Tax' }
      ],
      unpaid: [
        { key: 'fullName', label: 'Member' }, { key: 'phone', label: 'Phone' },
        { key: 'membershipPlans', label: 'Membership Plans' }, { key: 'paymentStatus', label: 'Payment Status' },
        { key: 'totalFees', label: 'Fees' }, { key: 'totalPaid', label: 'Paid' },
        { key: 'pendingAmount', label: 'Pending' }
      ],
      partial: [
        { key: 'fullName', label: 'Member' }, { key: 'phone', label: 'Phone' },
        { key: 'membershipPlans', label: 'Membership Plans' }, { key: 'paymentStatus', label: 'Payment Status' },
        { key: 'totalFees', label: 'Fees' }, { key: 'totalPaid', label: 'Paid' },
        { key: 'pendingAmount', label: 'Pending' }
      ],
      fullyPaid: [
        { key: 'fullName', label: 'Member' }, { key: 'phone', label: 'Phone' },
        { key: 'membershipPlans', label: 'Membership Plans' }, { key: 'paymentStatus', label: 'Payment Status' },
        { key: 'totalFees', label: 'Fees' }, { key: 'totalPaid', label: 'Paid' },
        { key: 'pendingAmount', label: 'Pending' }
      ],
      members: [
        { key: '_id', label: 'Member ID' }, { key: 'fullName', label: 'Member' }, { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' }, { key: 'joiningDate', label: 'Joining Date' },
        { key: 'status', label: 'Status' }, { key: 'membershipPlans', label: 'Membership Plans' },
        { key: 'activeMembershipCount', label: 'Active Memberships' },
        { key: 'paymentStatus', label: 'Payment Status' }, { key: 'totalFees', label: 'Fees' },
        { key: 'totalPaid', label: 'Paid' }, { key: 'pendingAmount', label: 'Pending' }
      ],
      newMembers: [
        { key: '_id', label: 'Member ID' }, { key: 'fullName', label: 'Member' }, { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' }, { key: 'joiningDate', label: 'Joining Date' },
        { key: 'status', label: 'Status' }, { key: 'membershipPlans', label: 'Membership Plans' },
        { key: 'paymentStatus', label: 'Payment Status' }, { key: 'pendingAmount', label: 'Pending' }
      ],
      activeMembers: [
        { key: '_id', label: 'Member ID' }, { key: 'fullName', label: 'Member' }, { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' }, { key: 'joiningDate', label: 'Joining Date' },
        { key: 'membershipPlans', label: 'Membership Plans' }, { key: 'activeMembershipCount', label: 'Active Memberships' },
        { key: 'paymentStatus', label: 'Payment Status' }, { key: 'pendingAmount', label: 'Pending' }
      ],
      inactiveMembers: [
        { key: '_id', label: 'Member ID' }, { key: 'fullName', label: 'Member' }, { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' }, { key: 'joiningDate', label: 'Joining Date' },
        { key: 'status', label: 'Status' }, { key: 'membershipPlans', label: 'Membership Plans' },
        { key: 'paymentStatus', label: 'Payment Status' }, { key: 'pendingAmount', label: 'Pending' }
      ],
      memberships: [
        { key: 'member.name', label: 'Member' }, { key: 'member.phone', label: 'Phone' },
        { key: 'plan.name', label: 'Plan' }, { key: 'startDate', label: 'Start Date' },
        { key: 'endDate', label: 'End Date' }, { key: 'planPrice', label: 'Fees' },
        { key: 'status', label: 'Membership Status' }
      ],
      expiring: [
        { key: 'member.name', label: 'Member' }, { key: 'member.phone', label: 'Phone' },
        { key: 'plan.name', label: 'Plan' }, { key: 'startDate', label: 'Start Date' },
        { key: 'endDate', label: 'End Date' }, { key: 'planPrice', label: 'Fees' },
        { key: 'status', label: 'Membership Status' }
      ],
      expiredMemberships: [
        { key: 'member.name', label: 'Member' }, { key: 'member.phone', label: 'Phone' },
        { key: 'plan.name', label: 'Plan' }, { key: 'startDate', label: 'Start Date' },
        { key: 'endDate', label: 'End Date' }, { key: 'planPrice', label: 'Fees' },
        { key: 'status', label: 'Membership Status' }
      ],
      renewedMemberships: [
        { key: 'member.name', label: 'Member' }, { key: 'member.phone', label: 'Phone' },
        { key: 'plan.name', label: 'Plan' }, { key: 'startDate', label: 'Start Date' },
        { key: 'endDate', label: 'End Date' }, { key: 'planPrice', label: 'Fees' }
      ],
      nonRenewedMembers: [
        { key: 'member.name', label: 'Member' }, { key: 'member.phone', label: 'Phone' },
        { key: 'plan.name', label: 'Plan' }, { key: 'startDate', label: 'Start Date' },
        { key: 'endDate', label: 'End Date' }, { key: 'planPrice', label: 'Fees' }
      ],
      attendance: [
        { key: 'member._id', label: 'Member ID' }, { key: 'member.name', label: 'Member' },
        { key: 'member.phone', label: 'Phone' },
        { key: 'attendanceDate', label: 'Date' }, { key: 'checkIn', label: 'Check-in' },
        { key: 'checkOut', label: 'Check-out' }, { key: 'attendanceType', label: 'Source' },
        { key: 'status', label: 'Status' }
      ],
      attendanceMembers: [
        { key: '_id', label: 'Member ID' }, { key: 'name', label: 'Member' }, { key: 'phone', label: 'Phone' },
        { key: 'visits', label: 'Attendance Days' }, { key: 'lastVisit', label: 'Last Visit' }
      ],
      trainers: [
        { key: 'name', label: 'Trainer' }, { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' }, { key: 'specialization', label: 'Specialization' },
        { key: 'assignedMemberCount', label: 'Assigned Members' },
        { key: 'assignedMembers', label: 'Member Details' }, { key: 'status', label: 'Status' }
      ],
      staff: [
        { key: 'name', label: 'Staff' }, { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' }, { key: 'designation', label: 'Designation' },
        { key: 'department', label: 'Department' }, { key: 'joiningDate', label: 'Joining Date' },
        { key: 'status', label: 'Status' }
      ]
    };
    if (definitions[type]?.length) return definitions[type];
    if (!records.length) {
      if (['unpaid', 'partial', 'fullyPaid'].includes(type)) {
        return [
          { key: 'fullName', label: 'Member' }, { key: 'phone', label: 'Phone' },
          { key: 'paymentStatus', label: 'Payment Status' }, { key: 'totalFees', label: 'Fees' },
          { key: 'totalPaid', label: 'Paid' }, { key: 'pendingAmount', label: 'Pending' }
        ];
      }
      if (['members', 'newMembers', 'activeMembers', 'inactiveMembers'].includes(type)) {
        return [
          { key: 'fullName', label: 'Member' }, { key: 'phone', label: 'Phone' },
          { key: 'joiningDate', label: 'Joining Date' }, { key: 'status', label: 'Status' },
          { key: 'paymentStatus', label: 'Payment Status' }, { key: 'pendingAmount', label: 'Pending' }
        ];
      }
      if (['memberships', 'expiring', 'expiredMemberships', 'renewedMemberships', 'nonRenewedMembers'].includes(type)) {
        return [
          { key: 'member.name', label: 'Member' }, { key: 'member.phone', label: 'Phone' },
          { key: 'plan.name', label: 'Plan' }, { key: 'startDate', label: 'Start Date' },
          { key: 'endDate', label: 'End Date' }, { key: 'planPrice', label: 'Fees' },
          { key: 'status', label: 'Status' }
        ];
      }
      if (['attendance', 'attendanceMembers'].includes(type)) {
        return type === 'attendance'
          ? [
            { key: 'member.name', label: 'Member' }, { key: 'member.phone', label: 'Phone' },
            { key: 'attendanceDate', label: 'Date' }, { key: 'checkIn', label: 'Check-in' },
            { key: 'checkOut', label: 'Check-out' }, { key: 'attendanceType', label: 'Source' },
            { key: 'status', label: 'Status' }
          ]
          : [
            { key: 'name', label: 'Member' }, { key: 'phone', label: 'Phone' },
            { key: 'visits', label: 'Visits' }, { key: 'lastVisit', label: 'Last Visit' }
          ];
      }
      return [
        { key: 'name', label: type === 'trainers' ? 'Trainer' : 'Staff' },
        { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
        { key: 'status', label: 'Status' }, { key: 'assignedMembers.length', label: 'Assigned Members' }
      ];
    }
    return Object.keys(records[0]).filter(key => !['_id', '__v', 'tenantId', 'businessId', 'createdBy'].includes(key))
      .slice(0, 8).map(key => ({ key, label: this.titleCase(key) }));
  }

  private titleCase(value: string): string {
    return value.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase());
  }

  private exportRows(records: ReportRecord[]): string[][] {
    return records.map(record => this.detailColumns.map(column => this.getCell(record, column)));
  }

  private exportCsv(records: ReportRecord[]): void {
    const businessName = this.report?.business?.businessName || 'Business';
    const rows = [
      ['Business', businessName],
      ['Report', this.reportTitle],
      ['Period', this.getPeriodLabel()],
      ['Generated', new Date().toLocaleString('en-IN')],
      ['Matching records', String(records.length)],
      ['Filtered amount', this.money(this.detailSummary?.amount || 0)],
      ['Filtered pending amount', this.money(this.detailSummary?.pendingAmount || 0)],
      [],
      this.detailColumns.map(column => column.label),
      ...this.exportRows(records)
    ];
    const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    this.downloadFile(`${this.fileBase()}.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
  }

  private exportExcel(records: ReportRecord[]): void {
    const html = this.reportHtml(records, true);
    this.downloadFile(`${this.fileBase()}.xls`, `\uFEFF${html}`, 'application/vnd.ms-excel;charset=utf-8');
  }

  private async exportPdf(records: ReportRecord[]): Promise<void> {
    const pdf = new jsPDF({ orientation: 'landscape' });
    const title = this.reportTitle;
    const businessName = this.report?.business?.businessName || 'Business';
    const generated = new Date().toLocaleString('en-IN');
    let headingX = 14;
    let headingY = 15;
    const logoUrl = String(this.report?.business?.logoUrl || '');
    if (logoUrl) {
      try {
        const image = logoUrl.startsWith('data:image/')
          ? logoUrl
          : await this.fetchImageData(logoUrl);
        const format = image.startsWith('data:image/png') ? 'PNG' : 'JPEG';
        pdf.addImage(image, format, 14, 8, 20, 20);
        headingX = 38;
        headingY = 16;
      } catch (error) {
        console.error('Business logo could not be added to report PDF:', error);
        this.detailError = 'Report exported, but the configured business logo could not be loaded for the PDF.';
      }
    }
    pdf.setFontSize(15);
    pdf.text(businessName, headingX, headingY);
    pdf.setFontSize(12);
    pdf.text(title, 14, 29);
    pdf.setFontSize(9);
    pdf.text(`Period: ${this.getPeriodLabel()}`, 14, 35);
    pdf.text(`Generated: ${generated} · Matching records: ${records.length}`, 14, 40);
    pdf.text(
      `Filtered summary: ${records.length} records · Amount ${this.money(this.detailSummary?.amount || 0)} · Fees ${this.money(this.detailSummary?.totalFees || 0)} · Paid ${this.money(this.detailSummary?.totalPaid || 0)} · Pending ${this.money(this.detailSummary?.pendingAmount || 0)}`,
      14,
      45
    );
    const pageWidth = pdf.internal.pageSize.getWidth();
    const widths = this.detailColumns.map(() => (pageWidth - 28) / Math.max(1, this.detailColumns.length));
    const rows = this.exportRows(records);
    let y = 53;
    pdf.setFontSize(6);
    const drawRow = (values: string[], bold = false): void => {
      const cells = values.map((value, index) =>
        pdf.splitTextToSize(value || '—', widths[index] - 3) as string[]
      );
      const rowHeight = Math.max(...cells.map(lines => lines.length)) * 3.2 + 3;
      if (y + rowHeight > pdf.internal.pageSize.getHeight() - 10) {
        pdf.addPage();
        y = 16;
      }
      pdf.setFont('helvetica', bold ? 'bold' : 'normal');
      let x = 14;
      cells.forEach((lines, index) => {
        pdf.text(lines, x + 1, y);
        x += widths[index];
      });
      y += rowHeight;
    };
    drawRow(this.detailColumns.map(column => column.label), true);
    rows.forEach(row => drawRow(row));
    pdf.save(`${this.fileBase()}.pdf`);
  }

  private printReport(records: ReportRecord[]): void {
    const popup = window.open('', '_blank', 'width=1100,height=850');
    if (!popup) {
      this.detailError = 'Allow pop-ups to print the report.';
      return;
    }
    popup.document.open();
    popup.document.write(this.reportHtml(records, false));
    popup.document.close();
  }

  private reportHtml(records: ReportRecord[], excel: boolean): string {
    const business = this.report?.business || {};
    const logo = business.logoUrl
      ? `<img class="logo" src="${this.escapeHtml(business.logoUrl)}" alt="Business logo">`
      : '';
    const rows = this.exportRows(records).map(row =>
      `<tr>${row.map(cell => `<td>${this.escapeHtml(cell)}</td>`).join('')}</tr>`
    ).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${this.escapeHtml(this.reportTitle)}</title>
      <style>body{font-family:Arial,sans-serif;color:#222;padding:24px}.brand{display:flex;align-items:center;gap:14px}.logo{max-width:70px;max-height:70px}h1{font-size:20px;margin:0}h2{font-size:16px;margin:8px 0}p{color:#666;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{border:1px solid #ddd;padding:7px;text-align:left;font-size:10px}th{background:#f2f3f5}button{margin-top:16px;padding:8px 14px}@media print{body{padding:0}button{display:none}}</style>
      </head><body><div class="brand">${logo}<h1>${this.escapeHtml(business.businessName || 'Business')}</h1></div>
      <h2>${this.escapeHtml(this.reportTitle)}</h2><p>Period: ${this.escapeHtml(this.getPeriodLabel())}</p>
      <p>Generated: ${this.escapeHtml(new Date().toLocaleString('en-IN'))} · Total matching records: ${records.length}</p>
      <p>Financial summary: Revenue ${this.escapeHtml(this.money(this.report?.summary?.totalRevenue || 0))},
      Net collection ${this.escapeHtml(this.money(this.report?.summary?.netCollection || 0))},
      Pending fees ${this.escapeHtml(this.money(this.report?.summary?.pendingFees || 0))}</p>
      <table><thead><tr>${this.detailColumns.map(column => `<th>${this.escapeHtml(column.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
      ${excel ? '' : '<button onclick="window.print()">Print</button>'}</body></html>`;
  }

  private downloadFile(filename: string, content: string, type: string): void {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private async fetchImageData(url: string): Promise<string> {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error(`Logo request failed with status ${response.status}`);
    const blob = await response.blob();
    if (!['image/png', 'image/jpeg'].includes(blob.type)) {
      throw new Error('PDF logo must be a PNG or JPEG image');
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not read the business logo image'));
      reader.onerror = () => reject(new Error('Could not read the business logo image'));
      reader.readAsDataURL(blob);
    });
  }

  private fileBase(): string {
    return `ss-fitness-${this.reportType}-${this.from}-to-${this.to}`;
  }

  private escapeHtml(value: string): string {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char] || char);
  }

  private loadPlans(): void {
    this.membershipPlans.getPlans().subscribe({
      next: response => {
        this.plans = response.plans || [];
        this.changeDetector.markForCheck();
      },
      error: error => {
        console.error('Report plan filter loading error:', error);
        this.detailError = 'Unable to load membership plan filters.';
        this.changeDetector.markForCheck();
      }
    });
  }

  private loadTrainers(): void {
    this.management.getStaff({ role: 'Trainer', status: 'Active', limit: 100 }).subscribe({
      next: response => {
        this.trainers = response.staff || [];
        this.changeDetector.markForCheck();
      },
      error: error => {
        console.error('Report trainer filter loading error:', error);
        this.detailError = 'Unable to load trainer filters.';
        this.changeDetector.markForCheck();
      }
    });
  }
}
