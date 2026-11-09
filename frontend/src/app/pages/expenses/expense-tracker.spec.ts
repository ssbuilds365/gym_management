import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ExpenseTracker } from './expense-tracker';
import { ExpenseService } from '../../services/expense';

describe('ExpenseTracker', () => {
  let component: ExpenseTracker;
  let fixture: ComponentFixture<ExpenseTracker>;
  let expenseService: {
    list: ReturnType<typeof vi.fn>;
    categories: ReturnType<typeof vi.fn>;
    getRetention: ReturnType<typeof vi.fn>;
    updateRetention: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    recordPayment: ReturnType<typeof vi.fn>;
    updateCategory: ReturnType<typeof vi.fn>;
    createCategory: ReturnType<typeof vi.fn>;
    report: ReturnType<typeof vi.fn>;
    export: ReturnType<typeof vi.fn>;
    allMatching: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    expenseService = {
      list: vi.fn().mockReturnValue(of({
        success: true,
        expenses: [],
        pagination: { page: 1, limit: 25, total: 0, totalPages: 0 },
        summary: {
          totalExpenses: 0,
          paidExpenses: 0,
          pendingExpenses: 0,
          outstandingAmount: 0,
          thisMonthExpenses: 0,
          todayExpenses: 0,
          highestExpenseCategory: null,
          categories: [],
          monthlyTrend: []
        },
        timeZone: 'Asia/Kolkata'
      })),
      categories: vi.fn().mockReturnValue(of({ categories: [
        { name: 'Rent', isActive: true, isDefault: true }
      ] })),
      getRetention: vi.fn().mockReturnValue(of({ retentionMonths: 12 })),
      updateRetention: vi.fn().mockReturnValue(of({ retentionMonths: 12 })),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      recordPayment: vi.fn(),
      updateCategory: vi.fn(),
      createCategory: vi.fn(),
      report: vi.fn(),
      export: vi.fn(),
      allMatching: vi.fn()
    };

    await TestBed.configureTestingModule({
      imports: [ExpenseTracker],
      providers: [{ provide: ExpenseService, useValue: expenseService }]
    }).compileComponents();
    fixture = TestBed.createComponent(ExpenseTracker);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('loads real expense summaries and completes loading', () => {
    expect(component.loading).toBe(false);
    expect(component.summary.totalExpenses).toBe(0);
    expect(component.categories[0].name).toBe('Rent');
  });

  it('preserves form values and reports API failures instead of closing', () => {
    expenseService.create.mockReturnValue(throwError(() => ({
      error: { message: 'Expense rejected' }
    })));
    component.openCreateForm();
    component.form.title = 'Power bill';
    component.form.category = 'Rent';
    component.form.amount = 100;
    component.form.expenseDate = '2026-11-06';

    component.saveExpense();

    expect(component.saving).toBe(false);
    expect(component.showForm).toBe(true);
    expect(component.form.title).toBe('Power bill');
    expect(component.formError).toBe('Expense rejected');
  });

  it('closes after confirmed creation and reloads the list', () => {
    expenseService.create.mockReturnValue(of({ success: true }));
    component.openCreateForm();
    component.form.title = 'Power bill';
    component.form.category = 'Rent';
    component.form.amount = 100;
    component.form.expenseDate = '2026-11-06';

    component.saveExpense();

    expect(component.showForm).toBe(false);
    expect(component.successMessage).toBe('Expense saved as pending.');
    expect(expenseService.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Power bill',
      amount: 100
    }));
    expect(expenseService.list).toHaveBeenCalledTimes(2);
  });

  it('uses the business timezone to render expense dates', () => {
    component.timeZone = 'America/Los_Angeles';
    expect(component.expenseDateInput('2026-03-08T08:00:00.000Z')).toBe('2026-03-08');
  });

  it('records a partial expense payment and immediately applies backend balances and summary', () => {
    const expense = {
      _id: 'expense-1',
      title: 'Electricity',
      category: 'Electricity',
      amount: 100,
      paidAmount: 0,
      outstandingAmount: 100,
      status: 'PENDING' as const,
      paymentMethod: null,
      expenseDate: '2026-11-09',
      vendor: '',
      invoiceNumber: '',
      transactionReference: '',
      description: '',
      payments: []
    };
    const updatedExpense = {
      ...expense,
      paidAmount: 40,
      outstandingAmount: 60,
      status: 'PARTIAL' as const,
      paymentMethod: 'Cash',
      payments: [{
        amount: 40,
        paymentMethod: 'Cash',
        paidAt: '2026-11-09',
        reference: '',
        notes: '',
        recordedBy: { name: 'Owner' }
      }]
    };
    const updatedSummary = {
      totalExpenses: 100,
      paidExpenses: 40,
      pendingExpenses: 60,
      outstandingAmount: 60,
      thisMonthExpenses: 100,
      todayExpenses: 100,
      highestExpenseCategory: null,
      categories: [],
      monthlyTrend: []
    };
    expenseService.recordPayment.mockReturnValue(of({
      success: true,
      expense: updatedExpense,
      summary: updatedSummary
    }));
    component.expenses = [expense];

    component.openPaymentForm(expense);
    component.paymentForm.amount = 40;
    component.recordPayment();

    expect(expenseService.recordPayment).toHaveBeenCalledWith(
      'expense-1',
      expect.objectContaining({ amount: 40, paymentMethod: 'Cash' }),
      expect.objectContaining({ period: 'month' })
    );
    expect(component.expenses[0].paidAmount).toBe(40);
    expect(component.expenses[0].outstandingAmount).toBe(60);
    expect(component.expenses[0].status).toBe('PARTIAL');
    expect(component.summary.paidExpenses).toBe(40);
    expect(component.summary.pendingExpenses).toBe(60);
    expect(component.summary.outstandingAmount).toBe(60);
    expect(component.showPaymentForm).toBe(false);
  });

  it('does not submit an expense payment that exceeds its outstanding amount', () => {
    const expense = {
      _id: 'expense-1',
      title: 'Rent',
      category: 'Rent',
      amount: 100,
      paidAmount: 60,
      outstandingAmount: 40,
      status: 'PARTIAL' as const,
      paymentMethod: 'Cash',
      expenseDate: '2026-11-09',
      vendor: '',
      invoiceNumber: '',
      transactionReference: '',
      description: '',
      payments: []
    };
    component.openPaymentForm(expense);
    component.paymentForm.amount = 50;

    component.recordPayment();

    expect(expenseService.recordPayment).not.toHaveBeenCalled();
    expect(component.paymentError).toContain('cannot exceed');
  });
});
