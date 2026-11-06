import {
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnInit,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import { MembershipPlanService } from '../../services/membership-plan';

@Component({
  selector: 'app-membership-plans',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './membership-plans.html',
  styleUrl: './membership-plans.scss'
})
export class MembershipPlans implements OnInit, OnChanges {
  @Input() active = false;

  plans: any[] = [];
  filteredPlans: any[] = [];

  searchText = '';
  statusFilter = '';

  loading = false;
  saving = false;
  deletingPlanId = '';
  private lastLoadedAt = 0;
  showForm = false;
  isEditMode = false;

  selectedPlanId = '';

  planForm: any = this.getEmptyForm();

  constructor(
    private planService: MembershipPlanService,
    private changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadPlans();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (
      changes['active'] &&
      !changes['active'].firstChange &&
      this.active &&
      (!this.lastLoadedAt || Date.now() - this.lastLoadedAt >= 60_000)
    ) {
      this.loadPlans();
    }
  }

  getEmptyForm(): any {
    return {
      planName: '',
      duration: 1,
      durationType: 'Months',
      price: 0,
      description: '',
      benefits: [],
      status: 'Active'
    };
  }

  loadPlans(): void {
    if (this.loading) {
      return;
    }

    this.loading = true;

    this.planService.getPlans()
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response) => {
        this.plans = response.plans || [];
        this.filterPlans();
        this.lastLoadedAt = Date.now();
      },
      error: (error) => {
        console.error('Plans loading error:', error);
        alert(error.error?.message || 'Unable to load plans');
      }
    });
  }

  filterPlans(): void {
    this.filteredPlans = this.plans.filter(plan => {
      const matchesSearch = plan.planName
        .toLowerCase()
        .includes(this.searchText.toLowerCase());

      const matchesStatus = !this.statusFilter ||
        plan.status === this.statusFilter;

      return matchesSearch && matchesStatus;
    });
  }

  openAddForm(): void {
    this.isEditMode = false;
    this.selectedPlanId = '';
    this.planForm = this.getEmptyForm();
    this.showForm = true;
  }

  openEditForm(plan: any): void {
    this.isEditMode = true;
    this.selectedPlanId = plan._id;

    this.planForm = {
      planName: plan.planName,
      duration: plan.duration,
      durationType: plan.durationType,
      price: plan.price,
      description: plan.description || '',
      benefits: [...(plan.benefits || [])],
      status: plan.status
    };

    this.showForm = true;
  }

  closeForm(): void {
    this.showForm = false;
  }

  addBenefit(): void {
    this.planForm.benefits.push('');
  }

  removeBenefit(index: number): void {
    this.planForm.benefits.splice(index, 1);
  }

  savePlan(): void {
    if (this.saving) {
      return;
    }

    if (
      !this.planForm.planName.trim() ||
      !this.planForm.duration ||
      this.planForm.duration < 1 ||
      this.planForm.price < 0
    ) {
      alert('Please enter valid plan details');
      return;
    }

    this.planForm.benefits = this.planForm.benefits
      .map((benefit: string) => benefit.trim())
      .filter((benefit: string) => benefit !== '');

    const request = this.isEditMode
      ? this.planService.updatePlan(this.selectedPlanId, this.planForm)
      : this.planService.addPlan(this.planForm);

    this.saving = true;
    request.pipe(finalize(() => {
      this.saving = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: (response) => {
        alert(response.message);
        this.closeForm();
        this.loadPlans();
      },
      error: (error) => {
        alert(error.error?.message || 'Unable to save membership plan');
      }
    });
  }

  deletePlan(plan: any): void {
    if (this.deletingPlanId) {
      return;
    }

    const confirmed = confirm(
      `Are you sure you want to delete ${plan.planName}?`
    );

    if (!confirmed) return;

    this.deletingPlanId = plan._id;
    this.planService.deletePlan(plan._id)
      .pipe(finalize(() => {
        this.deletingPlanId = '';
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response) => {
        alert(response.message);
        this.loadPlans();
      },
      error: (error) => {
        alert(error.error?.message || 'Unable to delete plan');
      }
    });
  }

  get activePlans(): number {
    return this.plans.filter(plan => plan.status === 'Active').length;
  }

  get inactivePlans(): number {
    return this.plans.filter(plan => plan.status === 'Inactive').length;
  }
}