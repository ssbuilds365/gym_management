import { ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import { ManagementService } from '../../services/management';
import { GST_STATES } from '../../utils/gst-states';
import { AuthService } from '../../services/auth';

@Component({
  selector: 'app-business-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.scss'
})
export class BusinessSettings implements OnInit {
  @Output() businessUpdated = new EventEmitter<string>();
  @Output() loggedOut = new EventEmitter<void>();
  @Output() passwordChanged = new EventEmitter<void>();

  loading = false;
  saving = false;
  errorMessage = '';
  successMessage = '';
  sessionsLoading = false;
  sessionsSaving = false;
  sessionsError = '';
  sessionsMessage = '';
  passwordChanging = false;
  passwordError = '';
  passwordSuccess = '';
  showCurrentPassword = false;
  showNewPassword = false;
  showConfirmPassword = false;
  passwordForm = {
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  };
  sessions: Array<{
    id: string;
    device: string;
    createdAt: string;
    lastActivityAt: string;
    expiresAt: string;
    current: boolean;
  }> = [];
  form = {
    businessName: '',
    businessType: 'Gym',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
    phone: '',
    email: '',
    address: '',
    logoUrl: '',
    gstEnabled: false,
    gstinNumber: '',
    legalBusinessName: '',
    registeredBusinessAddress: '',
    state: '',
    stateCode: '',
    gstPercentage: 0,
    taxInclusive: true
  };
  readonly businessTypes = ['Gym', 'Yoga Studio', 'Fitness Studio', 'Other'];
  readonly gstStates = GST_STATES;

  constructor(
    private readonly management: ManagementService,
    private readonly auth: AuthService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.load();
    this.loadSessions();
  }

  get hasOtherSessions(): boolean {
    return this.sessions.some(session => !session.current);
  }

  get passwordStrength(): number {
    const password = this.passwordForm.newPassword;
    if (!password) return 0;
    return [
      password.length >= 8,
      password.length >= 12,
      /[a-z]/.test(password) && /[A-Z]/.test(password),
      /\d/.test(password) && /[^A-Za-z0-9]/.test(password)
    ].filter(Boolean).length;
  }

  get passwordStrengthLabel(): string {
    if (!this.passwordForm.newPassword) return 'Not entered';
    return ['Weak', 'Weak', 'Fair', 'Good', 'Strong'][this.passwordStrength];
  }

  changePassword(): void {
    if (this.passwordChanging) return;
    this.passwordError = '';
    this.passwordSuccess = '';

    if (!this.passwordForm.currentPassword) {
      this.passwordError = 'Enter your current password.';
      return;
    }
    if (this.passwordForm.newPassword.length < 8) {
      this.passwordError = 'New password must be at least 8 characters long.';
      return;
    }
    if (new TextEncoder().encode(this.passwordForm.newPassword).length > 72) {
      this.passwordError = 'New password must be 72 bytes or fewer.';
      return;
    }
    if (this.passwordForm.newPassword !== this.passwordForm.confirmPassword) {
      this.passwordError = 'New password and confirmation do not match.';
      return;
    }

    this.passwordChanging = true;
    this.auth.changePassword(this.passwordForm)
      .pipe(finalize(() => {
        this.passwordChanging = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.passwordSuccess = response.message || 'Password changed. Please sign in again.';
          this.passwordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
          this.passwordChanged.emit();
        },
        error: error => {
          this.passwordError = error.error?.message || 'Unable to change password. Please try again.';
        }
      });
  }

  cancelPasswordChange(): void {
    this.passwordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
    this.passwordError = '';
    this.passwordSuccess = '';
    this.showCurrentPassword = false;
    this.showNewPassword = false;
    this.showConfirmPassword = false;
  }

  loadSessions(): void {
    this.sessionsLoading = true;
    this.sessionsError = '';
    this.auth.getSessions()
      .pipe(finalize(() => {
        this.sessionsLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => this.sessions = response.sessions || [],
        error: error => {
          console.error('Account sessions loading error:', error);
          this.sessionsError = error.error?.message || 'Unable to load account sessions.';
        }
      });
  }

  revokeSession(session: { id: string; current: boolean }): void {
    if (this.sessionsSaving) return;
    const message = session.current
      ? 'Log out this device now?'
      : 'Revoke this device session? It will need to sign in again.';
    if (!confirm(message)) return;
    this.sessionsSaving = true;
    this.sessionsError = '';
    this.auth.revokeSession(session.id)
      .pipe(finalize(() => {
        this.sessionsSaving = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          if (response.current) this.loggedOut.emit();
          else {
            this.sessionsMessage = 'Selected session revoked.';
            this.loadSessions();
          }
        },
        error: error => {
          console.error('Account session revoke error:', error);
          this.sessionsError = error.error?.message || 'Unable to revoke this session.';
        }
      });
  }

  revokeOtherSessions(): void {
    if (this.sessionsSaving || !this.sessions.some(session => !session.current)) return;
    if (!confirm('Log out all other devices? This device will remain signed in.')) return;
    this.sessionsSaving = true;
    this.sessionsError = '';
    this.auth.revokeOtherSessions()
      .pipe(finalize(() => {
        this.sessionsSaving = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: () => {
          this.sessionsMessage = 'Other device sessions revoked.';
          this.loadSessions();
        },
        error: error => {
          console.error('Other session revoke error:', error);
          this.sessionsError = error.error?.message || 'Unable to revoke other sessions.';
        }
      });
  }

  revokeAllSessions(): void {
    if (this.sessionsSaving) return;
    if (!confirm('Log out all devices, including this one?')) return;
    this.sessionsSaving = true;
    this.sessionsError = '';
    this.auth.revokeAllSessions()
      .pipe(finalize(() => {
        this.sessionsSaving = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: () => this.loggedOut.emit(),
        error: error => {
          console.error('All session revoke error:', error);
          this.sessionsError = error.error?.message || 'Unable to revoke sessions.';
        }
      });
  }

  onStateCodeChange(stateCode: string): void {
    this.form.state = this.gstStates.find(item => item.code === stateCode)?.name || '';
  }

  load(): void {
    this.loading = true;
    this.errorMessage = '';
    this.management.getSettings()
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          const business = response.business;
          this.form = {
            businessName: business.businessName || '',
            businessType: business.businessType || 'Other',
            timeZone: business.timeZone || 'Asia/Kolkata',
            phone: business.phone || '',
            email: business.email || '',
            address: business.address || '',
            logoUrl: business.logoUrl || '',
            gstEnabled: business.gstEnabled === true,
            gstinNumber: business.gstinNumber || '',
            legalBusinessName: business.legalBusinessName || '',
            registeredBusinessAddress: business.registeredBusinessAddress || '',
            state: business.state || '',
            stateCode: business.stateCode || '',
            gstPercentage: Number(business.gstPercentage || 0),
            taxInclusive: business.taxInclusive !== false
          };
        },
        error: error => {
          console.error('Business settings loading error:', error);
          this.errorMessage = error.error?.message || 'Unable to load settings.';
        }
      });
  }

  save(): void {
    if (this.saving) return;
    this.saving = true;
    this.errorMessage = '';
    this.successMessage = '';
    this.management.updateSettings(this.form)
      .pipe(finalize(() => {
        this.saving = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          const business = response.business;
          this.form = {
            businessName: business.businessName,
            businessType: business.businessType,
            timeZone: business.timeZone || 'Asia/Kolkata',
            phone: business.phone || '',
            email: business.email || '',
            address: business.address || '',
            logoUrl: business.logoUrl || '',
            gstEnabled: business.gstEnabled === true,
            gstinNumber: business.gstinNumber || '',
            legalBusinessName: business.legalBusinessName || '',
            registeredBusinessAddress: business.registeredBusinessAddress || '',
            state: business.state || '',
            stateCode: business.stateCode || '',
            gstPercentage: Number(business.gstPercentage || 0),
            taxInclusive: business.taxInclusive !== false
          };
          localStorage.setItem('business', JSON.stringify(business));
          this.businessUpdated.emit(business.businessName);
          this.successMessage = 'Business settings saved.';
        },
        error: error => {
          console.error('Business settings save error:', error);
          this.errorMessage = error.error?.message || 'Unable to save settings.';
        }
      });
  }
}
