
import {
  ChangeDetectorRef,
  Component,
  OnDestroy,
  Input,
  OnChanges,
  OnInit,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MemberService } from '../../services/member';
import { MembershipPlanService } from '../../services/membership-plan';
import * as QRCode from 'qrcode';
import { PaymentService } from '../../services/payment';
import { DashboardService } from '../../services/dashboard';
import { jsPDF } from 'jspdf';
import { environment } from '../../../environments/environment';
import {
  Subscription,
  Observable,
  finalize,
  forkJoin,
  from,
  switchMap,
  of,
  throwError,
  timeout,
  Subject,
  timer,
  map,
  catchError,
  distinctUntilChanged
} from 'rxjs';

@Component({
  selector: 'app-members',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './members.html',
  styleUrl: './members.scss'
})
export class Members implements OnInit, OnChanges, OnDestroy {
  readonly appName = environment.appName;
  @Input() active = false;
  @Input() focusMember: any = null;

  members: any[] = [];
  plans: any[] = [];

  search = '';
  status = '';
  dateRange = '';
  customDateFrom = '';
  customDateTo = '';
  exportLoading = false;
  exportErrorMessage = '';
  filterValidationMessage = '';
  readonly dateRangeOptions = [
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: 'week', label: 'This Week' },
    { value: 'month', label: 'This Month' },
    { value: 'lastMonth', label: 'Last Month' },
    { value: 'year', label: 'This Year' },
    { value: 'custom', label: 'Custom Date Range' }
  ];
  readonly selectedMemberRecords = new Map<string, any>();

  currentPage = 1;
  limit = 10;

  totalMembers = 0;
  totalPages = 0;

  loading = false;
  dataLoaded = false;
  errorMessage = '';
  successMessage = '';
  deletingMemberId = '';
  private lastLoadedAt = 0;
  private plansLoadedAt = 0;
  private plansLoading = false;
  private readonly memberQueries = new Subject<{
    search: string;
    status: string;
    page: number;
    from?: string;
    to?: string;
    debounce: boolean;
    validationError?: string;
  }>();
  private memberQuerySubscription?: Subscription;

  saving = false;
  showForm = false;
  isEditMode = false;
  selectedMemberId = '';
  private createdMemberId = '';
  private memberCreatedWithoutId = false;

  memberForm: any = this.getEmptyForm();

  // Membership History
showHistory = false;
historyLoading = false;
historyError = '';
selectedHistoryMember: any = null;
membershipHistory: any[] = [];
private historySubscription?: Subscription;
private historyRequestMemberId = '';
private historyCache = new Map<string, { records: any[]; loadedAt: number }>();

// QR Code
showQRModal = false;
qrLoading = false;
qrError = '';
qrImage = '';
qrMemberName = '';
qrMemberPhone = '';
selectedQrMember: any = null;
private qrSubscription?: Subscription;

// Financial Details
showFinancialDetails = false;
financialLoading = false;
financialError = '';
selectedFinancialMember: any = null;
memberPayments: any[] = [];
private financialSubscription?: Subscription;
private financialRequestMemberId = '';
private financialCache = new Map<string, {
  payments: any[];
  totalPlanAmount: number;
  totalPaidAmount: number;
  totalDueAmount: number;
  loadedAt: number;
}>();

totalPlanAmount = 0;
totalPaidAmount = 0;
totalDueAmount = 0;

  constructor(
    private memberService: MemberService,
    private planService: MembershipPlanService,
    private paymentService: PaymentService,
    private dashboardService: DashboardService,
    private changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.memberQuerySubscription = this.memberQueries.pipe(
      distinctUntilChanged((previous, current) =>
        previous.debounce &&
        current.debounce &&
        previous.search === current.search &&
        previous.status === current.status &&
        previous.page === current.page &&
        previous.from === current.from &&
        previous.to === current.to
      ),
      switchMap(query => {
        this.loading = true;
        this.errorMessage = '';
        this.filterValidationMessage = '';

        if (query.validationError) {
          return of({ type: 'validation' as const, message: query.validationError });
        }

        const request = query.debounce
          ? timer(300).pipe(
              switchMap(() => this.memberService.getMembers(
                query.search,
                query.status,
                query.page,
                this.limit,
                query.from,
                query.to
              ))
            )
          : this.memberService.getMembers(
              query.search,
              query.status,
              query.page,
              this.limit,
              query.from,
              query.to
            );

        return request.pipe(
          map(response => ({ type: 'success' as const, response })),
          catchError(error => of({ type: 'error' as const, error }))
        );
      })
    ).subscribe(result => {
      this.loading = false;
      if (result.type === 'validation') {
        this.filterValidationMessage = result.message;
        this.members = [];
        this.totalMembers = 0;
        this.totalPages = 0;
        this.changeDetector.markForCheck();
        return;
      }

      if (result.type === 'error') {
        console.error('Members loading error:', result.error);
        this.errorMessage =
          result.error.error?.message || 'Unable to load members';
        this.changeDetector.markForCheck();
        return;
      }

      const response = result.response;
      this.members = response.members || [];
      this.members.forEach(member => {
        if (this.selectedMemberRecords.has(member._id)) {
          this.selectedMemberRecords.set(member._id, member);
        }
      });
      this.totalMembers = response.pagination?.totalMembers || 0;
      this.totalPages = response.pagination?.totalPages || 0;
      this.dataLoaded = true;
      this.lastLoadedAt = Date.now();
      this.changeDetector.markForCheck();
    });
    this.loadMembers();
    this.loadPlans();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['focusMember']?.currentValue) {
      this.openMembershipHistory(changes['focusMember'].currentValue);
    }
    if (
      changes['active'] &&
      !changes['active'].firstChange &&
      this.active &&
      (!this.lastLoadedAt || Date.now() - this.lastLoadedAt >= 60_000)
    ) {
      if (!this.loading) {
        this.loadMembers();
      }
      this.loadPlans();
    }
  }

  ngOnDestroy(): void {
    this.memberQuerySubscription?.unsubscribe();
    this.memberQueries.complete();
    this.historySubscription?.unsubscribe();
    this.financialSubscription?.unsubscribe();
    this.qrSubscription?.unsubscribe();
  }

  getEmptyForm(): any {
    return {
      fullName: '',
      phone: '',
      email: '',
      gender: 'Male',
      dateOfBirth: '',
      address: '',
      emergencyContact: '',
      joiningDate: new Date().toISOString().split('T')[0],
      status: 'Active',
      notes: '',

      // Membership details
      planId: '',
      membershipStartDate: new Date().toISOString().split('T')[0],
      paidAmount: 0
    };
  }

  // Load members
  loadMembers(debounce = false): void {
    const dateBounds = this.getDateBounds();
    this.memberQueries.next({
      search: this.search,
      status: this.status,
      page: this.currentPage,
      from: dateBounds.from,
      to: dateBounds.to,
      debounce,
      validationError: dateBounds.error
    });
  }

  // Load active membership plans
  loadPlans(): void {
    if (
      this.plansLoading ||
      (this.plansLoadedAt && Date.now() - this.plansLoadedAt < 60_000)
    ) {
      return;
    }

    this.plansLoading = true;
    this.planService.getPlans()
      .pipe(finalize(() => {
        this.plansLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response) => {
        const allPlans = response.plans || response.membershipPlans || [];
        this.plans = allPlans.filter(
          (plan: any) => plan.status === 'Active'
        );
        this.plansLoadedAt = Date.now();
      },
      error: (error) => {
        console.error('Plans loading error:', error);
        this.plans = [];
      }
    });
  }

  // Selected plan
  get selectedPlan(): any {
    return this.plans.find(
      (plan: any) => plan._id === this.memberForm.planId
    );
  }

  // Calculate expiry date preview
  get membershipEndDate(): string {
    const plan = this.selectedPlan;
    const startDate = this.memberForm.membershipStartDate;

    if (!plan || !startDate) return '';

    const endDate = new Date(`${startDate}T00:00:00`);

    if (plan.durationType === 'Days') {
      endDate.setDate(endDate.getDate() + Number(plan.duration));
    } else if (plan.durationType === 'Months') {
      endDate.setMonth(endDate.getMonth() + Number(plan.duration));
    } else if (plan.durationType === 'Years') {
      endDate.setFullYear(
        endDate.getFullYear() + Number(plan.duration)
      );
    }

    return endDate.toISOString().split('T')[0];
  }

  // Search
  searchMembers(): void {
    this.currentPage = 1;
    this.loadMembers();
  }

  onSearchInput(): void {
    this.currentPage = 1;
    this.loadMembers(true);
  }

  onDateRangeChange(): void {
    this.exportErrorMessage = '';
    if (this.dateRange !== 'custom') {
      this.searchMembers();
      return;
    }

    this.searchMembers();
  }

  onCustomDateChange(): void {
    this.exportErrorMessage = '';
    this.searchMembers();
  }

  private toLocalDateInput(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getDateBounds(): { from?: string; to?: string; error?: string } {
    if (!this.dateRange) return {};

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let start: Date;
    let end: Date;

    switch (this.dateRange) {
      case 'today':
        start = today;
        end = new Date(today);
        end.setDate(end.getDate() + 1);
        break;
      case 'yesterday':
        end = today;
        start = new Date(today);
        start.setDate(start.getDate() - 1);
        break;
      case 'week': {
        start = new Date(today);
        const daysSinceMonday = (today.getDay() + 6) % 7;
        start.setDate(start.getDate() - daysSinceMonday);
        end = new Date(today);
        end.setDate(end.getDate() + 1);
        break;
      }
      case 'month':
        start = new Date(today.getFullYear(), today.getMonth(), 1);
        end = new Date(today);
        end.setDate(end.getDate() + 1);
        break;
      case 'lastMonth':
        start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        end = new Date(today.getFullYear(), today.getMonth(), 1);
        break;
      case 'year':
        start = new Date(today.getFullYear(), 0, 1);
        end = new Date(today);
        end.setDate(end.getDate() + 1);
        break;
      case 'custom': {
        if (!this.customDateFrom || !this.customDateTo) {
          return {
            error: 'Select both a start date and an end date for the custom range.'
          };
        }

        const fromParts = this.customDateFrom.split('-').map(Number);
        const toParts = this.customDateTo.split('-').map(Number);
        start = new Date(fromParts[0], fromParts[1] - 1, fromParts[2]);
        end = new Date(toParts[0], toParts[1] - 1, toParts[2]);
        if (
          this.toLocalDateInput(start) !== this.customDateFrom ||
          this.toLocalDateInput(end) !== this.customDateTo ||
          start > end
        ) {
          return {
            error: 'Enter a valid custom date range. The start date must not be after the end date.'
          };
        }
        end.setDate(end.getDate() + 1);
        break;
      }
      default:
        return { error: 'Select a valid joining date range.' };
    }

    return { from: start.toISOString(), to: end.toISOString() };
  }

  get allVisibleMembersSelected(): boolean {
    return this.members.length > 0 &&
      this.members.every(member => this.selectedMemberRecords.has(member._id));
  }

  isMemberSelected(member: any): boolean {
    return this.selectedMemberRecords.has(member._id);
  }

  toggleMemberSelection(member: any, selected: boolean): void {
    if (selected) {
      this.selectedMemberRecords.set(member._id, member);
    } else {
      this.selectedMemberRecords.delete(member._id);
    }
  }

  toggleVisibleMembers(selected: boolean): void {
    this.members.forEach(member => this.toggleMemberSelection(member, selected));
  }

  toggleVisibleMembersFromEvent(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.toggleVisibleMembers(target.checked);
  }

  clearSelectedMembers(): void {
    this.selectedMemberRecords.clear();
  }

  private getExportRows(): Observable<any[]> {
    const selected = [...this.selectedMemberRecords.values()];
    if (selected.length > 0) {
      return of(selected);
    }

    const bounds = this.getDateBounds();
    if (bounds.error) {
      return throwError(() => new Error(bounds.error));
    }

    return this.memberService.getAllMatchingMembers(
      this.search,
      this.status,
      bounds.from,
      bounds.to
    );
  }

  private toExportRecords(members: any[]): string[][] {
    return members.map(member => [
      String(member._id || ''),
      String(member.fullName || ''),
      String(member.phone || ''),
      String(member.email || ''),
      member.joiningDate
        ? new Date(member.joiningDate).toLocaleDateString('en-IN')
        : '',
      String(member.membership?.planId?.planName || ''),
      String(member.membership?.paymentStatus || ''),
      String(member.status || '')
    ]);
  }

  private getExportContext(): { businessName: string; generatedAt: string } {
    const businessJson = localStorage.getItem('business');
    let businessName = this.appName;
    if (businessJson) {
      try {
        businessName = JSON.parse(businessJson).businessName || this.appName;
      } catch (error) {
        console.error('Unable to read business name for member export:', error);
      }
    }
    return {
      businessName,
      generatedAt: new Date().toLocaleString('en-IN')
    };
  }

  private getReportTitle(): string {
    const selectedCount = this.selectedMemberRecords.size;
    return selectedCount > 0
      ? `Selected Members Report (${selectedCount})`
      : 'Members Report';
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character] || character);
  }

  private openReportWindow(printAfterLoad: boolean): Window | null {
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      this.exportErrorMessage =
        'The report window was blocked. Allow pop-ups and try again.';
      return null;
    }

    this.exportLoading = true;
    this.exportErrorMessage = '';
    this.getExportRows()
      .pipe(finalize(() => this.exportLoading = false))
      .subscribe({
        next: members => {
          const records = this.toExportRecords(members);
          const context = this.getExportContext();
          const headers = [
            'Member ID',
            'Name',
            'Phone',
            'Email',
            'Joining Date',
            'Membership Plan',
            'Payment Status',
            'Member Status'
          ];
          const rows = records.map(record =>
            `<tr>${record.map(value => `<td>${this.escapeHtml(value)}</td>`).join('')}</tr>`
          ).join('');
          reportWindow.document.open();
          reportWindow.document.write(`<!doctype html>
            <html><head><meta charset="utf-8"><title>${this.escapeHtml(this.getReportTitle())}</title>
            <style>
              @page { size: landscape; margin: 14mm; }
              body { font-family: Arial, sans-serif; color: #202124; padding: 18px; }
              h1 { margin: 0 0 6px; color: #b51f2b; font-size: 22px; }
              h2 { margin: 0 0 8px; font-size: 17px; }
              .meta { color: #666; font-size: 11px; margin-bottom: 18px; }
              table { width: 100%; border-collapse: collapse; }
              th { background: #252630; color: #fff; text-align: left; }
              th, td { padding: 8px; border: 1px solid #d8d8d8; font-size: 10px; }
              tbody tr:nth-child(even) { background: #f5f6f8; }
              .count { margin-top: 12px; color: #555; font-size: 11px; }
              @media screen { body { max-width: 1200px; margin: auto; } }
            </style></head><body>
            <h1>${this.escapeHtml(context.businessName)}</h1>
            <h2>${this.escapeHtml(this.getReportTitle())}</h2>
            <div class="meta">Generated: ${this.escapeHtml(context.generatedAt)}</div>
            <table><thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${headers.length}">No matching members.</td></tr>`}</tbody></table>
            <div class="count">Total members: ${records.length}</div>
            </body></html>`);
          reportWindow.document.close();
          if (printAfterLoad) {
            reportWindow.focus();
            reportWindow.print();
          }
        },
        error: error => {
          console.error('Member report generation error:', error);
          this.exportErrorMessage =
            error.message || 'Unable to prepare the member report.';
          reportWindow.close();
        }
      });
    return reportWindow;
  }

  exportPdf(): void {
    this.downloadExportFile('pdf');
  }

  printReport(): void {
    this.openReportWindow(true);
  }

  exportCsv(): void {
    this.downloadExportFile('csv');
  }

  exportExcel(): void {
    this.downloadExportFile('excel');
  }

  private downloadExportFile(format: 'csv' | 'excel' | 'pdf'): void {
    if (this.exportLoading) return;
    this.exportLoading = true;
    this.exportErrorMessage = '';
    this.getExportRows()
      .pipe(finalize(() => this.exportLoading = false))
      .subscribe({
        next: members => {
          const records = this.toExportRecords(members);
          const headers = [
            'Member ID',
            'Name',
            'Phone',
            'Email',
            'Joining Date',
            'Membership Plan',
            'Payment Status',
            'Member Status'
          ];
          const context = this.getExportContext();
          const title = this.getReportTitle();
          if (format === 'pdf') {
            this.createPdf(headers, records, context, title);
            return;
          }
          const content = format === 'csv'
            ? this.createCsv(headers, records, context, title)
            : this.createExcelXml(headers, records, context, title);
          const blob = new Blob(
            [content],
            { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/vnd.ms-excel;charset=utf-8' }
          );
          this.downloadBlob(
            blob,
            `members-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : 'xls'}`
          );
        },
        error: error => {
          console.error('Member export error:', error);
          this.exportErrorMessage =
            error.message || 'Unable to export matching members.';
        }
      });
  }

  private createPdf(
    headers: string[],
    records: string[][],
    context: { businessName: string; generatedAt: string },
    title: string
  ): void {
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const margin = 10;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const columnWidths = [0.11, 0.12, 0.1, 0.17, 0.12, 0.15, 0.12, 0.11]
      .map(weight => (pageWidth - margin * 2) * weight);
    const headerHeight = 10;
    let y = 16;

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(17);
    pdf.setTextColor(181, 31, 43);
    const businessName = pdf.splitTextToSize(
      context.businessName,
      pageWidth - margin * 2
    );
    pdf.text(businessName, margin, y);
    y += Math.max(8, businessName.length * 7);
    pdf.setFontSize(12);
    pdf.setTextColor(32, 33, 36);
    pdf.text(title, margin, y);
    y += 6;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(100, 100, 100);
    pdf.text(`Generated: ${context.generatedAt}`, margin, y);
    y += 7;

    const drawHeader = (): void => {
      let x = margin;
      headers.forEach((header, index) => {
        const width = columnWidths[index];
        pdf.setFillColor(37, 38, 48);
        pdf.setDrawColor(216, 216, 216);
        pdf.rect(x, y, width, headerHeight, 'FD');
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(7);
        pdf.setTextColor(255, 255, 255);
        pdf.text(
          pdf.splitTextToSize(header, width - 3),
          x + 1.5,
          y + 4
        );
        x += width;
      });
      y += headerHeight;
    };

    drawHeader();
    const pdfRecords = records.length
      ? records
      : [['No matching members.', '', '', '', '', '', '', '']];
    pdfRecords.forEach((record, rowIndex) => {
      const wrapped = record.map((value, index) =>
        pdf.splitTextToSize(value || '—', columnWidths[index] - 3)
      );
      const lineCount = Math.max(...wrapped.map(lines => lines.length));
      const rowHeight = Math.max(7, lineCount * 3.5 + 3);
      if (y + rowHeight > pageHeight - margin) {
        pdf.addPage();
        y = margin;
        drawHeader();
      }

      let x = margin;
      record.forEach((_value, index) => {
        const width = columnWidths[index];
        pdf.setFillColor(rowIndex % 2 === 0 ? 255 : 245, rowIndex % 2 === 0 ? 255 : 246, rowIndex % 2 === 0 ? 255 : 248);
        pdf.setDrawColor(216, 216, 216);
        pdf.rect(x, y, width, rowHeight, 'FD');
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7);
        pdf.setTextColor(32, 33, 36);
        pdf.text(wrapped[index], x + 1.5, y + 4);
        x += width;
      });
      y += rowHeight;
    });

    pdf.save(`members-${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  private createCsv(
    headers: string[],
    records: string[][],
    context: { businessName: string; generatedAt: string },
    title: string
  ): string {
    const rows = [
      [context.businessName],
      [title],
      [`Generated: ${context.generatedAt}`],
      [],
      headers,
      ...records
    ];
    return `\uFEFF${rows.map(row =>
      row.map(value => {
        const text = String(value);
        const safeText = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
        return `"${safeText.replace(/"/g, '""')}"`;
      }).join(',')
    ).join('\r\n')}`;
  }

  private createExcelXml(
    headers: string[],
    records: string[][],
    context: { businessName: string; generatedAt: string },
    title: string
  ): string {
    const xmlEscape = (value: string) =>
      this.escapeHtml(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const row = (cells: string[], style?: string) =>
      `<Row>${cells.map(value =>
        `<Cell${style ? ` ss:StyleID="${style}"` : ''}><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`
      ).join('')}</Row>`;
    return `<?xml version="1.0"?>
      <?mso-application progid="Excel.Sheet"?>
      <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
       xmlns:o="urn:schemas-microsoft-com:office:office"
       xmlns:x="urn:schemas-microsoft-com:office:excel"
       xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
       <Styles>
        <Style ss:ID="Title"><Font ss:Bold="1" ss:Size="16" ss:Color="#B51F2B"/></Style>
        <Style ss:ID="Heading"><Font ss:Bold="1" ss:Size="12"/></Style>
        <Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#252630" ss:Pattern="Solid"/></Style>
       </Styles>
       <Worksheet ss:Name="Members"><Table>
        ${row([context.businessName], 'Title')}
        ${row([title], 'Heading')}
        ${row([`Generated: ${context.generatedAt}`])}
        <Row/>
        ${row(headers, 'Header')}
        ${records.map(record => row(record)).join('')}
       </Table></Worksheet></Workbook>`;
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  // Open Add Form
  openAddForm(): void {
    this.isEditMode = false;
    this.selectedMemberId = '';
    this.createdMemberId = '';
    this.memberCreatedWithoutId = false;
    this.memberForm = this.getEmptyForm();
    this.showForm = true;
    this.loadPlans();
  }

  // Open Edit Form
  openEditForm(member: any): void {
    this.isEditMode = true;
    this.selectedMemberId = member._id;
    this.createdMemberId = '';
    this.memberCreatedWithoutId = false;

    this.memberForm = {
      fullName: member.fullName,
      phone: member.phone,
      email: member.email || '',
      gender: member.gender,
      dateOfBirth: member.dateOfBirth
        ? new Date(member.dateOfBirth).toISOString().split('T')[0]
        : '',
      address: member.address || '',
      emergencyContact: member.emergencyContact || '',
      joiningDate: member.joiningDate
        ? new Date(member.joiningDate).toISOString().split('T')[0]
        : '',
      status: member.status,
      notes: member.notes || '',

      // Existing member edit does not change membership
      planId: '',
      membershipStartDate: new Date().toISOString().split('T')[0],
      paidAmount: 0
    };

    this.showForm = true;
    this.loadPlans();
  }

  closeForm(): void {
    this.showForm = false;
    this.createdMemberId = '';
    this.memberCreatedWithoutId = false;
  }

  // Save member and optionally assign membership
  saveMember(): void {
    if (this.memberCreatedWithoutId) return;
    if (
      !this.memberForm.fullName.trim() ||
      !this.memberForm.phone.trim()
    ) {
      this.errorMessage = 'Please enter member name and phone number';
      return;
    }

    if (this.saving) return;

    if (!this.isEditMode && this.memberForm.planId) {
      if (!this.memberForm.membershipStartDate) {
        this.errorMessage = 'Please select membership start date';
        return;
      }

    }

    this.saving = true;
    this.errorMessage = '';
    this.successMessage = '';

    const isEditMode = this.isEditMode;
    const planId = this.memberForm.planId;
    const createdMemberId = this.createdMemberId;
    const membershipRequest = (memberId: string) =>
      this.planService.assignMembership({
        memberId,
        planId,
        startDate: this.memberForm.membershipStartDate,
        paidAmount: 0
      });

    const request = createdMemberId
      ? membershipRequest(createdMemberId).pipe(
          map(response => ({ response, memberId: createdMemberId, assigned: true }))
        )
      : (isEditMode
          ? this.memberService.updateMember(this.selectedMemberId, this.memberForm)
          : this.memberService.addMember(this.memberForm)
        ).pipe(
          switchMap(response => {
            const memberId = isEditMode
              ? this.selectedMemberId
              : response.member?._id || response.data?._id;

            if (!isEditMode && planId && !memberId) {
              this.memberCreatedWithoutId = true;
              return of({ response, memberId: '', assigned: false });
            }

            if (!isEditMode && planId && memberId) {
              this.createdMemberId = memberId;
              return membershipRequest(memberId).pipe(
                map(assignment => ({
                  response: assignment,
                  memberId,
                  assigned: true
                }))
              );
            }

            return of({ response, memberId, assigned: false });
          })
        );

    request.pipe(
      finalize(() => {
        this.saving = false;
        this.changeDetector.markForCheck();
      })
    ).subscribe({
      next: result => {
        if (this.memberCreatedWithoutId) {
          this.errorMessage =
            'The member was created, but the server did not return its ID. Do not resubmit; refresh the member list and assign a membership from that record.';
          this.currentPage = 1;
          this.loadMembers();
          this.dashboardService.requestRefresh();
          return;
        }

        if (result.assigned && result.memberId) {
          this.historyCache.delete(result.memberId);
          this.financialCache.delete(result.memberId);
          this.dashboardService.requestRefresh();
        }

        this.successMessage = result.assigned
          ? 'Member and membership saved successfully. Collect payment from Payments & Fees.'
          : result.response.message || 'Member saved successfully';
        this.createdMemberId = '';
        this.closeForm();
        if (!isEditMode) this.currentPage = 1;
        this.loadMembers();
        this.dashboardService.requestRefresh();
      },
      error: error => {
        const message = this.createdMemberId
          ? 'Member created, but membership assignment failed: ' +
            (error.error?.message || 'Review the details and retry the membership assignment.')
          : error.error?.message || 'Unable to save member';
        if (this.createdMemberId) {
          this.currentPage = 1;
          this.loadMembers();
        }
        this.errorMessage = message;
      }
    });
  }

  // Delete member
  deleteMember(member: any): void {
    if (this.deletingMemberId) return;
    const confirmed = confirm(
      `Permanently delete ${member.fullName} and remove eligible operational data? Financial payment records required for retention will be preserved and anonymized. This cannot be undone.`
    );

    if (!confirmed) return;

    this.deletingMemberId = member._id;
    this.errorMessage = '';
    this.successMessage = '';
    this.memberService.deleteMember(member._id)
      .pipe(finalize(() => {
        this.deletingMemberId = '';
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response) => {
        this.members = this.members.filter(item => item._id !== member._id);
        this.selectedMemberRecords.delete(member._id);
        this.totalMembers = Math.max(0, this.totalMembers - 1);
        this.totalPages = Math.ceil(this.totalMembers / this.limit);
        this.successMessage = response.message || 'Member deleted successfully.';
        if (this.members.length === 0 && this.currentPage > 1) {
          this.currentPage--;
          this.loadMembers();
        }
      },
      error: (error) => {
        this.errorMessage = error.error?.message || 'Unable to delete member';
      }
    });
  }

  // Pagination
  changePage(page: number): void {
    if (page < 1 || page > this.totalPages) return;

    this.currentPage = page;
    this.loadMembers();
  }

  openMembershipHistory(member: any, retry = false): void {
    const memberId = member?._id;
    if (!memberId) {
      this.historyError = 'Unable to identify this member.';
      this.showHistory = true;
      return;
    }

    this.selectedHistoryMember = member;
    this.showHistory = true;
    this.historyError = '';

    const cached = this.historyCache.get(memberId);
    if (!retry && cached && Date.now() - cached.loadedAt < 30_000) {
      this.membershipHistory = cached.records;
      this.historyLoading = false;
      return;
    }

    if (this.historyLoading && this.historyRequestMemberId === memberId) {
      return;
    }

    this.historyRequestMemberId = memberId;
    this.historySubscription?.unsubscribe();
    this.membershipHistory = [];
    this.historyLoading = true;

    this.historySubscription = this.planService.getMemberMemberships(memberId)
      .pipe(
        timeout({ first: 20_000 }),
        finalize(() => {
          if (this.historyRequestMemberId === memberId) {
            this.historyLoading = false;
            this.historyRequestMemberId = '';
            this.changeDetector.markForCheck();
          }
        })
      )
      .subscribe({
        next: (response) => {
          const records = response?.memberships ?? response?.data;
          if (!Array.isArray(records)) {
            this.historyError = 'Membership history response was invalid.';
            return;
          }
          this.membershipHistory = records;
          this.historyCache.set(memberId, { records, loadedAt: Date.now() });
        },
        error: (error) => {
          console.error('Membership history error:', error);
          this.historyError =
            error.error?.message ||
            (error.name === 'TimeoutError'
              ? 'Loading membership history timed out. Please retry.'
              : 'Unable to load membership history. Please retry.');
          this.changeDetector.markForCheck();
        }
      });
  }

  closeMembershipHistory(): void {
    this.showHistory = false;
    this.selectedHistoryMember = null;
    this.historyRequestMemberId = '';
    this.historySubscription?.unsubscribe();
    this.historySubscription = undefined;
    this.historyLoading = false;
    this.historyError = '';
  }

  generateQR(member: any): void {
    if (this.qrLoading) {
      return;
    }

    if (!member?._id) {
      this.qrError = 'Unable to identify this member.';
      this.showQRModal = true;
      return;
    }

    this.qrLoading = true;
    this.qrError = '';
    this.qrImage = '';
    this.qrMemberName = member.fullName || 'Member';
    this.qrMemberPhone = member.phone || '';
    this.selectedQrMember = member;
    this.showQRModal = true;

    this.qrSubscription = this.memberService.generateMemberQR(member._id)
      .pipe(
        switchMap((response: any) => {
          if (!response?.success || !response.qrToken) {
            return throwError(() => new Error(
              response?.message || 'QR token was not returned by the server.'
            ));
          }

          return from(QRCode.toDataURL(response.qrToken, {
            width: 300,
            margin: 2,
            errorCorrectionLevel: 'H'
          }));
        }),
        timeout({ first: 20_000 }),
        finalize(() => {
          this.qrLoading = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: (image) => {
          this.qrImage = image;
        },
        error: (error) => {
          console.error('QR generation error:', error);
          this.qrError =
            error.error?.message ||
            (error.name === 'TimeoutError'
              ? 'QR generation timed out. Please retry.'
              : error.message || 'Unable to generate QR Code.');
          this.changeDetector.markForCheck();
        }
      });
  }

  closeQRModal(): void {
    this.showQRModal = false;
    this.qrSubscription?.unsubscribe();
    this.qrSubscription = undefined;
    this.qrLoading = false;
    this.qrImage = '';
    this.qrError = '';
    this.selectedQrMember = null;
  }

  downloadQR(): void {
    if (!this.qrImage) return;

    const link = document.createElement('a');
    link.href = this.qrImage;
    link.download = `${this.qrMemberName}-QR.png`;
    link.click();
  }

  openFinancialDetails(member: any, retry = false): void {
    const memberId = member?._id;
    if (!memberId) {
      this.financialError = 'Unable to identify this member.';
      this.showFinancialDetails = true;
      return;
    }

    this.selectedFinancialMember = member;
    this.showFinancialDetails = true;
    this.financialError = '';

    const cached = this.financialCache.get(memberId);
    if (!retry && cached && Date.now() - cached.loadedAt < 30_000) {
      this.memberPayments = cached.payments;
      this.totalPlanAmount = cached.totalPlanAmount;
      this.totalPaidAmount = cached.totalPaidAmount;
      this.totalDueAmount = cached.totalDueAmount;
      this.financialLoading = false;
      return;
    }

    if (this.financialLoading && this.financialRequestMemberId === memberId) {
      return;
    }

    this.financialRequestMemberId = memberId;
    this.financialSubscription?.unsubscribe();
    this.financialLoading = true;
    this.memberPayments = [];
    this.totalPlanAmount = 0;
    this.totalPaidAmount = 0;
    this.totalDueAmount = 0;

    forkJoin({
      paymentResponse: this.paymentService.getMemberPayments(memberId),
      membershipResponse: this.planService.getMemberMemberships(memberId)
    })
      .pipe(
        timeout({ first: 20_000 }),
        finalize(() => {
          if (this.financialRequestMemberId === memberId) {
            this.financialLoading = false;
            this.financialRequestMemberId = '';
            this.changeDetector.markForCheck();
          }
        })
      )
      .subscribe({
        next: ({ paymentResponse, membershipResponse }) => {
          if (!Array.isArray(paymentResponse?.payments) ||
              !Array.isArray(membershipResponse?.memberships ?? membershipResponse?.data)) {
            this.financialError = 'Financial details response was invalid.';
            return;
          }

          const memberships =
            membershipResponse.memberships ?? membershipResponse.data;
          this.memberPayments = paymentResponse.payments;
          this.totalPlanAmount = memberships.reduce(
            (total: number, item: any) =>
              total + Number(item.planPrice || 0), 0
          );
          this.totalPaidAmount = memberships.reduce(
            (total: number, item: any) =>
              total + Number(item.paidAmount || 0), 0
          );
          this.totalDueAmount = Math.max(
            0,
            this.totalPlanAmount - this.totalPaidAmount
          );
          this.financialCache.set(memberId, {
            payments: this.memberPayments,
            totalPlanAmount: this.totalPlanAmount,
            totalPaidAmount: this.totalPaidAmount,
            totalDueAmount: this.totalDueAmount,
            loadedAt: Date.now()
          });
        },
        error: (error) => {
          console.error('Financial details error:', error);
          this.financialError =
            error.error?.message ||
            (error.name === 'TimeoutError'
              ? 'Loading financial details timed out. Please retry.'
              : 'Unable to load financial details. Please retry.');
          this.changeDetector.markForCheck();
        }
      });
  }

  closeFinancialDetails(): void {
    this.showFinancialDetails = false;
    this.selectedFinancialMember = null;
    this.financialRequestMemberId = '';
    this.financialSubscription?.unsubscribe();
    this.financialSubscription = undefined;
    this.financialLoading = false;
    this.memberPayments = [];
    this.financialError = '';
  }


printReceipt(payment: any): void {
  const receiptWindow = window.open('', '_blank', 'width=800,height=700');

  if (!receiptWindow) {
    this.financialError = 'Please allow pop-ups to view the verified receipt.';
    return;
  }

  this.paymentService.getPaymentReceipt(payment._id).subscribe({
    next: response => {
      const receipt = response?.receipt;
      if (!response?.success || !receipt) {
        receiptWindow.close();
        this.financialError = 'Verified receipt details were not returned.';
        return;
      }

      const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[char] || char);
      const rows = [
        ['Receipt number', receipt.receiptNumber],
        ['Member', receipt.member?.fullName],
        ['Member ID', receipt.member?.id],
        ['Phone', receipt.member?.phone],
        ['Membership plan', receipt.membership?.planName],
        ['Transaction ID', receipt.payment?.transactionId],
        ['Payment method', receipt.payment?.paymentMethod],
        ['Payment date', receipt.paymentDate ? new Date(receipt.paymentDate).toLocaleDateString('en-IN') : '-'],
        ['Amount received', `INR ${Number(receipt.payment?.amountReceived || 0).toFixed(2)}`],
        ['Total membership fees', `INR ${Number(receipt.summary?.totalMembershipFees || 0).toFixed(2)}`],
        ['Total amount paid', `INR ${Number(receipt.summary?.totalAmountPaid || 0).toFixed(2)}`],
        ['Pending amount', `INR ${Number(receipt.summary?.pendingAmount || 0).toFixed(2)}`],
        ['Payment status', receipt.summary?.status]
      ];
      const taxRows = receipt.taxInvoice ? [
        ['Tax invoice', receipt.taxInvoice.invoiceNumber],
        ['Taxable amount', `INR ${Number(receipt.taxInvoice.taxableAmount || 0).toFixed(2)}`],
        ['GST rate', `${receipt.taxInvoice.gstPercentage}%`],
        [receipt.taxInvoice.componentMode, `INR ${Number(receipt.taxInvoice.totalTax || 0).toFixed(2)}`],
        ['Invoice total', `INR ${Number(receipt.taxInvoice.totalAmount || 0).toFixed(2)}`]
      ] : [];
      receiptWindow.document.open();
      receiptWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title>
        <style>body{font:14px Arial,sans-serif;color:#252525;padding:28px}.receipt{max-width:680px;margin:auto;border:1px solid #ddd;padding:30px}
        h1{color:#b51f2b}h2{font-size:15px;border-bottom:1px solid #ddd;padding-bottom:8px;margin-top:24px}
        .sub{color:#777;font-size:12px}.row{display:flex;justify-content:space-between;gap:15px;padding:8px 0;border-bottom:1px solid #eee}
        .row span{color:#777}.row strong{text-align:right}.footer{text-align:center;color:#777;margin-top:28px}
        button{display:block;margin:20px auto;background:#b51f2b;color:white;padding:10px 18px;border:0;border-radius:6px}
        @media print{button{display:none}body{padding:0}}</style></head><body><main class="receipt">
        <h1>${escape(receipt.business?.businessName || this.appName)}</h1>
        <div class="sub">${escape(receipt.business?.address || '')} · ${escape(receipt.business?.phone || '')} · ${escape(receipt.business?.email || '')}</div>
        <h2>Payment Receipt</h2>${rows.map(([label, value]) => `<div class="row"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join('')}
        ${taxRows.length ? `<h2>GST Tax Invoice</h2>${taxRows.map(([label, value]) => `<div class="row"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join('')}` : ''}
        <div class="footer">Thank you for being a member of our gym.<p>Receipt confirms money received; the tax invoice, if shown, records the taxable supply.</p></div>
        <button onclick="window.print()">Print Receipt</button></main></body></html>`);
      receiptWindow.document.close();
    },
    error: error => {
      console.error('Verified member receipt loading error:', error);
      receiptWindow.close();
      this.financialError = error.error?.message || 'Unable to load the verified receipt.';
      this.changeDetector.markForCheck();
    }
  });
}


}
