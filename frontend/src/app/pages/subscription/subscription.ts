import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { finalize } from 'rxjs';
import { ManagementService } from '../../services/management';

@Component({
  selector: 'app-subscription',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './subscription.html',
  styleUrl: './subscription.scss'
})
export class SubscriptionPage implements OnInit {
  loading = false;
  errorMessage = '';
  status = '';

  constructor(
    private readonly management: ManagementService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loading = true;
    this.management.getSubscription()
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => this.status = response.subscription?.status || 'Unknown',
        error: error => {
          console.error('Subscription status loading error:', error);
          this.errorMessage = error.error?.message || 'Unable to load subscription status.';
        }
      });
  }
}
