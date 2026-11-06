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
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
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
          thisMonthExpenses: 0,
          todayExpenses: 0,
          highestExpenseCategory: null
        },
        timeZone: 'Asia/Kolkata'
      })),
      categories: vi.fn().mockReturnValue(of({ categories: [
        { name: 'Rent', isActive: true, isDefault: true }
      ] })),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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
    expect(component.successMessage).toBe('Expense saved.');
    expect(expenseService.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Power bill',
      amount: 100,
      status: 'PENDING',
      paidAmount: 0
    }));
    expect(expenseService.list).toHaveBeenCalledTimes(2);
  });

  it('uses the business timezone to render expense dates', () => {
    component.timeZone = 'America/Los_Angeles';
    expect(component.expenseDateInput('2026-03-08T08:00:00.000Z')).toBe('2026-03-08');
  });
});
