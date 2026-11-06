import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { Reports } from './reports';
import { ManagementService } from '../../services/management';
import { MembershipPlanService } from '../../services/membership-plan';

describe('Reports', () => {
  let fixture: ComponentFixture<Reports>;
  let component: Reports;
  let management: {
    getReport: ReturnType<typeof vi.fn>;
    getStaff: ReturnType<typeof vi.fn>;
  };

  const overview = {
    success: true,
    business: { businessName: 'Test Gym', logoUrl: '' },
    period: { from: '2026-11-01', to: '2026-11-04', timezone: 'Asia/Kolkata' },
    summary: {
      totalRevenue: 1200,
      netCollection: 1100,
      pendingFees: 800,
      totalActiveMembers: 20,
      totalMembers: 25,
      newMembers: 3,
      retentionRate: 75,
      retentionCohort: 8,
      retainedMembers: 6,
      averageAttendancePercentage: 30,
      totalTrainers: 2,
      activeTrainers: 1,
      assignedTrainerMembers: 4,
      totalStaff: 3,
      activeStaff: 2,
      gst: { invoices: 0, taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 },
      comparison: { changePercentage: 12.5 }
    },
    charts: {
      monthlyRevenue: [],
      memberGrowth: [],
      attendanceTrend: [],
      membershipPlanDistribution: [],
      paymentStatusDistribution: [],
      paymentMethodCollection: [],
      planWiseRevenue: [],
      dailyCollection: [],
      weekdayAttendance: [],
      peakAttendanceHours: [],
      attendanceSources: {}
    },
    insights: {
      revenueChange: 12.5,
      mostPopularPlan: null,
      upcomingRenewals: 0,
      upcomingRenewalRecords: [],
      expiredMemberships: 0,
      highestRegistrationMonth: null,
      lowAttendanceMembers: [],
      highestAttendanceMembers: [],
      trainerWorkload: []
    },
    capabilities: {
      trainerAttendance: false,
      staffAttendance: false,
      salaryTransactions: false,
      cancellationHistory: false
    }
  };

  beforeEach(async () => {
    management = {
      getReport: vi.fn((filters: Record<string, any>) => of(filters['detailsOnly']
        ? {
          success: true,
          detail: {
            records: [{ _id: 'payment-1', amount: 1200 }],
            total: 1,
            page: 1,
            totalPages: 1,
            summary: { recordCount: 1, amount: 1200 }
          }
        }
        : overview)),
      getStaff: vi.fn().mockReturnValue(of({ staff: [] }))
    };

    await TestBed.configureTestingModule({
      imports: [Reports],
      providers: [
        { provide: ManagementService, useValue: management },
        { provide: MembershipPlanService, useValue: { getPlans: vi.fn().mockReturnValue(of({ plans: [] })) } }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(Reports);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('loads the overview and paginated detail records for the selected period', () => {
    expect(management.getReport).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'month', timezone: expect.any(String) })
    );
    expect(component.report.business.businessName).toBe('Test Gym');
    expect(component.detailTotal).toBe(1);
    expect(component.detailRecords[0]['amount']).toBe(1200);
    expect(component.summaryCards[0].value).toBe('₹1,200.00');
  });

  it('keeps report options free of removed batch reporting', () => {
    const optionLabels = component.reportOptions.map(option => option.label).join(' ');
    expect(optionLabels.toLowerCase()).not.toContain('batch');
    expect(component.reportOptions.some(option => option.value === 'attendance')).toBe(true);
    expect(component.reportOptions.some(option => option.value === 'gst')).toBe(true);
  });

  it('requests tenant-scoped filters and all-record exports through service query options', () => {
    component.reportType = 'attendance';
    component.attendanceSource = 'QR';
    component.trainerId = 'trainer-1';
    component.loadDetails();

    expect(management.getReport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'attendance',
        attendanceSource: 'QR',
        trainerId: 'trainer-1',
        detailsOnly: true
      })
    );
  });

  it('debounces detail searches and requests the latest search term', async () => {
    component.search = 'kim';
    component.onDetailSearchChange();

    await new Promise(resolve => setTimeout(resolve, 350));

    expect(management.getReport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detailsOnly: true,
        search: 'kim',
        page: 1
      })
    );
  });
});
