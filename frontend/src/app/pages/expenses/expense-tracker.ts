import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize, of, Subscription, switchMap } from 'rxjs';
import { jsPDF } from 'jspdf';
import { ExpenseQuery, ExpenseService } from '../../services/expense';

interface ExpenseCategory {
  _id?: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
}

interface ExpenseRecord {
  _id: string;
  title: string;
  category: string;
  amount: number;
  paidAmount: number;
  outstandingAmount: number;
  status: 'PAID' | 'PENDING' | 'PARTIALLY_PAID';
  paymentMethod: string | null;
  expenseDate: string;
  vendor: string;
  invoiceNumber: string;
  transactionReference: string;
  description: string;
  notes?: string;
  dueDate?: string | null;
  archivedAt?: string | null;
  receipt?: { originalName: string; uploadedAt: string } | null;
  payments: Array<{
    amount: number;
    paymentMethod: string;
    paidAt: string;
    reference: string;
    notes: string;
  }>;
}

const todayLocal = (): string => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

@Component({
  selector: 'app-expense-tracker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './expense-tracker.html',
  styleUrl: './expense-tracker.scss'
})
export class ExpenseTracker implements OnInit, OnDestroy {
  expenses: ExpenseRecord[] = [];
  categories: ExpenseCategory[] = [];
  summary: any = null;
  pagination = { page: 1, limit: 25, total: 0, totalPages: 0 };
  timeZone = 'Asia/Kolkata';
  period = 'month';
  customFrom = `${todayLocal().slice(0, 7)}-01`;
  customTo = todayLocal();
  search = '';
  categoryFilter = '';
  statusFilter = '';
  archiveFilter: 'active' | 'archived' = 'active';
  sortBy = 'expenseDate';
  sortDirection: 'asc' | 'desc' = 'desc';

  loading = false;
  categoriesLoading = false;
  saving = false;
  deletingId = '';
  exporting = false;
  reportLoading = false;
  errorMessage = '';
  successMessage = '';
  reportError = '';
  report: any = null;
  retentionMonths = 12;
  retentionSaving = false;
  retentionMessage = '';

  showForm = false;
  editingExpense: ExpenseRecord | null = null;
  formError = '';
  form: any = this.emptyForm();

  showDetails = false;
  selectedExpense: ExpenseRecord | null = null;
  showCategoryManager = false;
  showCategoryForm = false;
  editingCategory: ExpenseCategory | null = null;
  categorySaving = false;
  categoryError = '';
  categoryName = '';
  categoryActive = true;
  businessNameValue = 'SS Fitness Manager';

  readonly paymentMethods = ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Other'];
  private listRequest?: Subscription;
  private categoryRequest?: Subscription;
  private reportRequest?: Subscription;
  private saveRequest?: Subscription;
  private deleteRequest?: Subscription;
  private exportRequest?: Subscription;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private customRangeInitialized = false;
  private paymentRequestId = '';
  receiptFile: File | null = null;

  constructor(
    private readonly expenseService: ExpenseService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadCategories();
    this.loadRetention();
    this.loadExpenses();
  }

  ngOnDestroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.listRequest?.unsubscribe();
    this.categoryRequest?.unsubscribe();
    this.reportRequest?.unsubscribe();
    this.saveRequest?.unsubscribe();
    this.deleteRequest?.unsubscribe();
    this.exportRequest?.unsubscribe();
  }

  private emptyForm(): any {
    return {
      title: '',
      category: '',
      amount: '',
      expenseDate: this.businessToday(),
      dueDate: '',
      notes: '',
      paymentAmount: '',
      paymentDate: this.businessToday(),
      paymentMethod: 'Cash',
      paymentReference: '',
      vendor: '',
      invoiceNumber: '',
      transactionReference: '',
      description: '',
      paymentNotes: ''
    };
  }

  loadCategories(): void {
    this.categoryRequest?.unsubscribe();
    this.categoriesLoading = true;
    this.categoryRequest = this.expenseService.categories()
      .pipe(finalize(() => {
        this.categoriesLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.categories = response.categories || [];
          if (!this.form.category) {
            this.form.category = this.categories.find(item => item.isActive)?.name || '';
          }
        },
        error: error => {
          console.error('Expense category loading error:', error);
          this.errorMessage = error.error?.message || 'Unable to load expense categories.';
        }
      });
  }

  private query(page = 1): ExpenseQuery {
    const query: ExpenseQuery = {
      search: this.search.trim(),
      category: this.categoryFilter,
      status: this.statusFilter,
      archived: this.archiveFilter === 'archived' ? 'true' : undefined,
      page,
      limit: this.pagination.limit,
      sortBy: this.sortBy,
      sortDirection: this.sortDirection
    };
    if (this.period !== 'all') query.period = this.period;
    if (this.period === 'custom') {
      query.from = this.customFrom;
      query.to = this.customTo;
    }
    return query;
  }

  loadExpenses(page = 1): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
    this.listRequest?.unsubscribe();
    this.loading = true;
    this.errorMessage = '';
    this.listRequest = this.expenseService.list(this.query(page))
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.expenses = response.expenses || [];
          this.summary = response.summary || null;
          this.pagination = response.pagination || this.pagination;
          this.timeZone = response.timeZone || this.timeZone;
          if (!this.customRangeInitialized) {
            const today = this.businessToday();
            this.customFrom = `${today.slice(0, 7)}-01`;
            this.customTo = today;
            this.customRangeInitialized = true;
          }
        },
        error: error => {
          console.error('Expense list loading error:', error);
          this.errorMessage = error.error?.message || 'Unable to load expenses.';
        }
      });
  }

  onSearchChange(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      this.loadExpenses(1);
    }, 300);
  }

  onFiltersChange(): void {
    this.loadExpenses(1);
  }

  changePage(delta: number): void {
    const page = Math.max(1, Math.min(this.pagination.totalPages, this.pagination.page + delta));
    if (page !== this.pagination.page) this.loadExpenses(page);
  }

  openCreateForm(): void {
    this.editingExpense = null;
    this.paymentRequestId = '';
    this.receiptFile = null;
    this.form = this.emptyForm();
    this.form.category = this.categories.find(item => item.isActive)?.name || '';
    this.formError = '';
    this.showForm = true;
  }

  openEditForm(expense: ExpenseRecord): void {
    this.editingExpense = expense;
    this.paymentRequestId = '';
    this.receiptFile = null;
    this.form = {
      title: expense.title,
      category: expense.category,
      amount: expense.amount,
      expenseDate: this.expenseDateInput(expense.expenseDate),
      dueDate: expense.dueDate ? this.expenseDateInput(expense.dueDate) : '',
      notes: expense.notes || '',
      paymentAmount: '',
      paymentDate: this.businessToday(),
      paymentMethod: expense.paymentMethod || 'Cash',
      paymentReference: '',
      vendor: expense.vendor,
      invoiceNumber: expense.invoiceNumber,
      transactionReference: expense.transactionReference,
      description: expense.description,
      paymentNotes: ''
    };
    this.formError = '';
    this.showForm = true;
  }

  closeForm(): void {
    if (this.saving) return;
    this.showForm = false;
    this.formError = '';
  }

  saveExpense(): void {
    if (this.saving) return;
    this.formError = '';
    const payload: Record<string, unknown> = {
      title: this.form.title,
      category: this.form.category,
      amount: Number(this.form.amount),
      expenseDate: this.form.expenseDate,
      vendor: this.form.vendor,
      invoiceNumber: this.form.invoiceNumber,
      transactionReference: this.form.transactionReference,
      description: this.form.description,
      dueDate: this.form.dueDate || null,
      notes: this.form.notes
    };

    this.saving = true;
    const editingExpense = this.editingExpense;
    if (editingExpense && Number(this.form.paymentAmount) > 0 && !this.paymentRequestId) {
      this.paymentRequestId = crypto.randomUUID();
    }
    const request = editingExpense
      ? this.expenseService.update(editingExpense._id, payload).pipe(
          switchMap(response => Number(this.form.paymentAmount) > 0
            ? this.expenseService.recordPayment(editingExpense._id, {
                amount: Number(this.form.paymentAmount),
                paymentMethod: this.form.paymentMethod,
                paymentDate: this.form.paymentDate,
                reference: this.form.paymentReference,
                notes: this.form.paymentNotes,
                requestId: this.paymentRequestId
              })
            : of(response)),
          switchMap(response => this.receiptFile
            ? this.expenseService.uploadReceipt(editingExpense._id, this.receiptFile)
            : of(response))
        )
      : this.expenseService.create(payload).pipe(
          switchMap(response => {
            const createdId = response.expense?._id;
            if (!createdId) return of(response);
            this.editingExpense = response.expense;
            return this.receiptFile
              ? this.expenseService.uploadReceipt(createdId, this.receiptFile)
              : of(response);
          })
        );
    this.saveRequest = request.pipe(finalize(() => {
      this.saving = false;
      this.changeDetector.markForCheck();
    }))
      .subscribe({
        next: response => {
          if (!response?.success) {
            this.formError = 'The server did not confirm the expense change.';
            return;
          }
          this.showForm = false;
          this.paymentRequestId = '';
          this.receiptFile = null;
          this.successMessage = editingExpense ? 'Expense updated.' : 'Expense saved as pending.';
          this.loadExpenses(1);
        },
        error: error => {
          console.error('Expense save error:', error);
          this.formError = error.error?.message || error.message || 'Unable to save expense.';
          if (this.editingExpense) {
            this.successMessage = 'Expense details were saved, but the receipt or payment step failed. You can retry safely.';
            this.loadExpenses(1);
          }
        }
      });
  }

  onReceiptSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] || null;
    if (file && file.size > 8 * 1024 * 1024) {
      this.formError = 'Receipt file must be 8 MB or smaller.';
      input.value = '';
      this.receiptFile = null;
      return;
    }
    this.formError = '';
    this.receiptFile = file;
  }

  openReceipt(expense: ExpenseRecord): void {
    const popup = window.open('', '_blank');
    this.expenseService.receiptUrl(expense._id).subscribe({
      next: response => {
        if (popup) popup.location.href = response.url;
        else window.location.href = response.url;
      },
      error: error => {
        popup?.close();
        console.error('Expense receipt access error:', error);
        this.errorMessage = error.error?.message || 'Unable to open the receipt.';
      }
    });
  }

  removeExpense(expense: ExpenseRecord): void {
    if (this.deletingId) return;
    const confirmed = window.confirm(
      `Archive "${expense.title}"? It will be removed from active expense totals; the change will be retained in the audit history.`
    );
    if (!confirmed) return;
    this.deletingId = expense._id;
    this.deleteRequest?.unsubscribe();
    this.deleteRequest = this.expenseService.delete(expense._id)
      .pipe(finalize(() => {
        this.deletingId = '';
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.successMessage = response.message || 'Expense archived.';
          this.loadExpenses(this.pagination.page);
        },
        error: error => {
          console.error('Expense archive error:', error);
          this.errorMessage = error.error?.message || 'Unable to archive expense.';
        }
      });
  }

  restoreExpense(expense: ExpenseRecord): void {
    if (this.deletingId) return;
    this.deletingId = expense._id;
    this.expenseService.restore(expense._id)
      .pipe(finalize(() => {
        this.deletingId = '';
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: () => {
          this.successMessage = 'Expense restored to active records.';
          this.loadExpenses(this.pagination.page);
        },
        error: error => {
          console.error('Expense restore error:', error);
          this.errorMessage = error.error?.message || 'Unable to restore expense.';
        }
      });
  }

  loadRetention(): void {
    this.expenseService.getRetention().subscribe({
      next: response => this.retentionMonths = Number(response.retentionMonths) || 12,
      error: error => {
        console.error('Expense retention settings error:', error);
        this.errorMessage = error.error?.message || 'Unable to load retention settings.';
      }
    });
  }

  saveRetention(): void {
    if (this.retentionSaving) return;
    this.retentionSaving = true;
    this.retentionMessage = '';
    this.expenseService.updateRetention(Number(this.retentionMonths))
      .pipe(finalize(() => {
        this.retentionSaving = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.retentionMonths = Number(response.retentionMonths);
          this.retentionMessage = 'Retention preference saved. No records are automatically deleted.';
        },
        error: error => {
          console.error('Expense retention update error:', error);
          this.retentionMessage = error.error?.message || 'Unable to save retention preference.';
        }
      });
  }

  selectArchiveTab(tab: 'active' | 'archived'): void {
    if (this.archiveFilter === tab) return;
    this.archiveFilter = tab;
    this.loadExpenses(1);
  }

  get maxCategoryTotal(): number {
    return Math.max(1, ...(this.summary?.categories || []).map((item: any) => Number(item.amount) || 0));
  }

  categoryBarWidth(value: number): string {
    return `${Math.max(4, Math.round((Number(value) / this.maxCategoryTotal) * 100))}%`;
  }

  get maxTrendTotal(): number {
    return Math.max(1, ...(this.summary?.monthlyTrend || []).map((item: any) => Number(item.total) || 0));
  }

  trendBarHeight(value: number): string {
    return `${Math.max(3, Math.round((Number(value) / this.maxTrendTotal) * 100))}%`;
  }

  monthLabel(value: string): string {
    const date = new Date(`${value}-01T00:00:00`);
    return new Intl.DateTimeFormat('en', { month: 'short' }).format(date);
  }

  openDetails(expense: ExpenseRecord): void {
    this.selectedExpense = expense;
    this.showDetails = true;
  }

  openCategoryManager(): void {
    this.showCategoryManager = true;
    this.showCategoryForm = false;
    this.categoryError = '';
  }

  openCategoryForm(category?: ExpenseCategory): void {
    this.editingCategory = category || null;
    this.categoryName = category?.name || '';
    this.categoryActive = category?.isActive ?? true;
    this.categoryError = '';
    this.showCategoryForm = true;
  }

  saveCategory(): void {
    if (this.categorySaving) return;
    this.categorySaving = true;
    this.categoryError = '';
    const request = this.editingCategory?._id
      ? this.expenseService.updateCategory(this.editingCategory._id, {
          name: this.categoryName,
          isActive: this.categoryActive
        })
      : this.expenseService.createCategory(this.categoryName);
    request.pipe(finalize(() => {
      this.categorySaving = false;
      this.changeDetector.markForCheck();
    }))
      .subscribe({
        next: response => {
          if (!response?.success) {
            this.categoryError = 'The server did not confirm the category change.';
            return;
          }
          this.showCategoryForm = false;
          this.loadCategories();
        },
        error: error => {
          console.error('Expense category save error:', error);
          this.categoryError = error.error?.message || 'Unable to save category.';
        }
      });
  }

  loadReport(): void {
    const query = this.query(1);
    this.reportRequest?.unsubscribe();
    this.reportLoading = true;
    this.reportError = '';
    this.reportRequest = this.expenseService.report(query)
      .pipe(finalize(() => {
        this.reportLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.report = response;
          this.businessNameValue = response.businessName || this.businessNameValue;
        },
        error: error => {
          console.error('Expense report error:', error);
          this.reportError = error.error?.message || 'Unable to generate expense report.';
        }
      });
  }

  exportCsv(): void {
    this.downloadExport('csv');
  }

  exportExcel(): void {
    this.downloadExport('xlsx');
  }

  private downloadExport(format: 'csv' | 'xlsx'): void {
    if (this.exporting) return;
    this.exporting = true;
    this.exportRequest?.unsubscribe();
    this.exportRequest = this.expenseService.export(this.query(1), format)
      .pipe(finalize(() => {
        this.exporting = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: blob => this.saveBlob(blob, `ssfm-expenses-${todayLocal()}.${format}`),
        error: error => {
          console.error('Expense export error:', error);
          this.errorMessage = error.error?.message || 'Unable to export expenses.';
        }
      });
  }

  exportPdf(): void {
    this.exportAllRows(rows => this.createPdf(rows));
  }

  printReport(): void {
    const popup = window.open('', '_blank');
    if (!popup) {
      this.errorMessage = 'Allow pop-ups to print the expense report.';
      return;
    }
    this.exportAllRows(rows => this.writePrintReport(popup, rows), popup);
  }

  private exportAllRows(
    onSuccess: (rows: ExpenseRecord[]) => void,
    popup?: Window
  ): void {
    if (this.exporting) {
      popup?.close();
      return;
    }
    this.exporting = true;
    this.exportRequest?.unsubscribe();
    this.exportRequest = this.expenseService.allMatching(this.query(1))
      .pipe(finalize(() => {
        this.exporting = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: rows => onSuccess(rows),
        error: error => {
          popup?.close();
          console.error('Expense report export error:', error);
          this.errorMessage = error.error?.message || 'Unable to prepare the full expense report.';
        }
      });
  }

  private createPdf(rows: ExpenseRecord[]): void {
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const margin = 14;
    const pageHeight = pdf.internal.pageSize.getHeight();
    const title = 'Expense Report';
    const totals = rows.reduce((result, expense) => ({
      amount: result.amount + expense.amount,
      paid: result.paid + expense.paidAmount,
      outstanding: result.outstanding + expense.outstandingAmount
    }), { amount: 0, paid: 0, outstanding: 0 });
    const categories = this.categoryTotals(rows);
    let y = 18;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(16);
    pdf.text(this.businessName(), margin, y);
    y += 8;
    pdf.setFontSize(12);
    pdf.text(title, margin, y);
    y += 7;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(`Generated ${new Date().toLocaleString('en-IN')} · ${this.timeZone}`, margin, y);
    y += 8;
    pdf.text(this.dateRangeLabel(), margin, y);
    y += 8;
    pdf.text(
      `Total ${this.money(totals.amount)} · Paid ${this.money(totals.paid)} · Outstanding ${this.money(totals.outstanding)}`,
      margin,
      y
    );
    y += 8;
    pdf.setFont('helvetica', 'bold');
    pdf.text('Category totals', margin, y);
    y += 6;
    pdf.setFont('helvetica', 'normal');
    for (const [category, amount] of categories) {
      if (y + 6 > pageHeight - margin) {
        pdf.addPage();
        y = margin;
      }
      pdf.text(`${category}: ${this.money(amount)}`, margin, y);
      y += 5;
    }
    y += 4;
    pdf.setFont('helvetica', 'bold');
    pdf.text('Transactions', margin, y);
    y += 7;
    pdf.setFont('helvetica', 'normal');
    for (const expense of rows) {
      const line = `${this.formatDate(expense.expenseDate)} | ${expense.title} | ${expense.category} | ${this.money(expense.amount)} | Paid ${this.money(expense.paidAmount)} | ${expense.status}`;
      const wrapped = pdf.splitTextToSize(line, pdf.internal.pageSize.getWidth() - margin * 2);
      if (y + wrapped.length * 5 > pageHeight - margin) {
        pdf.addPage();
        y = margin;
      }
      pdf.text(wrapped, margin, y);
      y += wrapped.length * 5 + 2;
    }
    pdf.save(`ssfm-expenses-${todayLocal()}.pdf`);
  }

  private writePrintReport(popup: Window, rows: ExpenseRecord[]): void {
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const paid = rows.reduce((sum, row) => sum + row.paidAmount, 0);
    const categories = [...this.categoryTotals(rows)].map(([name, amount]) =>
      `<tr><td>${this.escapeHtml(name)}</td><td>${this.money(amount)}</td></tr>`
    ).join('');
    const body = rows.map(row => `<tr><td>${this.escapeHtml(this.formatDate(row.expenseDate))}</td><td>${this.escapeHtml(row.title)}</td><td>${this.escapeHtml(row.category)}</td><td>${this.escapeHtml(row.vendor)}</td><td>${this.money(row.amount)}</td><td>${this.money(row.paidAmount)}</td><td>${this.money(row.outstandingAmount)}</td><td>${this.escapeHtml(row.status)}</td></tr>`).join('');
    popup.document.open();
    popup.document.write(`<!doctype html><html><head><title>Expense Report</title><style>
      body{font:12px Arial,sans-serif;color:#20232b;margin:24px}h1{margin:0 0 6px;color:#b51f2b}
      p{color:#626875}.summary{display:flex;gap:24px;margin:18px 0;font-weight:bold}
      table{border-collapse:collapse;width:100%;margin-bottom:20px}th,td{border:1px solid #dfe2e8;padding:7px;text-align:left}
      th{background:#f3f4f6}td:nth-child(n+5){text-align:right}
      @media print{body{margin:12mm}thead{display:table-header-group}tr{break-inside:avoid}}
    </style></head><body><h1>${this.escapeHtml(this.businessName())}</h1>
      <h2>Expense Report</h2><p>${this.escapeHtml(this.dateRangeLabel())}</p>
      <p>Generated ${this.escapeHtml(new Date().toLocaleString('en-IN'))} · ${this.escapeHtml(this.timeZone)}</p>
      <div class="summary"><span>Total: ${this.money(total)}</span><span>Paid: ${this.money(paid)}</span><span>Outstanding: ${this.money(total - paid)}</span></div>
      <h3>Category-wise totals</h3><table><thead><tr><th>Category</th><th>Total</th></tr></thead><tbody>${categories}</tbody></table>
      <h3>Transactions</h3>
      <table><thead><tr><th>Date</th><th>Title</th><th>Category</th><th>Vendor</th><th>Total</th><th>Paid</th><th>Outstanding</th><th>Status</th></tr></thead><tbody>${body}</tbody></table>
      <script>window.onload=()=>window.print()</script></body></html>`);
    popup.document.close();
  }

  private categoryTotals(rows: ExpenseRecord[]): Map<string, number> {
    const totals = new Map<string, number>();
    rows.forEach(row => totals.set(row.category, (totals.get(row.category) || 0) + row.amount));
    return new Map([...totals.entries()].sort((left, right) => right[1] - left[1]));
  }

  private dateRangeLabel(): string {
    if (this.period === 'custom') return `${this.customFrom} to ${this.customTo}`;
    return this.report?.range
      ? `${this.report.range.from} to ${this.report.range.to}`
      : this.reportTitle;
  }

  private saveBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private businessName(): string {
    try {
      const business = JSON.parse(localStorage.getItem('business') || '{}');
      return String(business.businessName || this.businessNameValue);
    } catch (error) {
      console.error('Unable to read business name for expense report:', error);
      return this.businessNameValue;
    }
  }

  private escapeHtml(value: string): string {
    return String(value || '').replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character] || character);
  }

  expenseDateInput(value: string): string {
    const date = new Date(value);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const part = (type: string) => parts.find(item => item.type === type)?.value || '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  formatDate(value: string): string {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: this.timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(new Date(value));
  }

  private businessToday(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const part = (type: string) => parts.find(item => item.type === type)?.value || '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  money(value: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number(value || 0));
  }

  get activeCategories(): ExpenseCategory[] {
    return this.categories.filter(category => category.isActive);
  }

  hasPaymentAmount(): boolean {
    return Number(this.form.paymentAmount) > 0;
  }

  get reportTitle(): string {
    const labels: Record<string, string> = {
      today: 'Daily Expense Report',
      week: 'Weekly Expense Report',
      month: 'Monthly Expense Report',
      year: 'Yearly Expense Report',
      custom: 'Custom Date Range Expense Report',
      yesterday: 'Yesterday Expense Report',
      lastMonth: 'Last Month Expense Report',
      all: 'Expense Report'
    };
    return labels[this.period] || 'Expense Report';
  }
}
