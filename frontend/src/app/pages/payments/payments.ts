
import {
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize, Subscription } from 'rxjs';

import { PaymentService } from '../../services/payment';
import { MemberService } from '../../services/member';
import { MembershipPlanService } from '../../services/membership-plan';
import { DashboardService } from '../../services/dashboard';
import { environment } from '../../../environments/environment';
import { jsPDF } from 'jspdf';
import { GST_STATES } from '../../utils/gst-states';

@Component({
  selector: 'app-payments',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './payments.html',
  styleUrl: './payments.scss'
})
export class Payments implements OnInit, OnChanges, OnDestroy {
  readonly appName = environment.appName;
  @Input() active = false;

  payments: any[] = [];
  members: any[] = [];
  memberships: any[] = [];
  currentPage = 1;
  readonly pageLimit = 25;
  totalPayments = 0;
  totalPages = 0;
  paymentSummary = {
    totalTransactions: 0,
    totalCollection: 0,
    pendingTransactions: 0,
    totalOutstanding: null as number | null
  };
  paymentSummaryLoaded = false;
  private queuedPaymentPage?: number;
  private lastLoadedAt = 0;
  private membershipRequest?: Subscription;

  loading = false;
  membersLoading = false;
  membershipsLoading = false;
  savingPayment = false;
  receiptLoadingId = '';

  errorMessage = '';
  successMessage = '';
  receiptErrorMessage = '';
  readonly gstStates = GST_STATES;

  showPaymentForm = false;

  selectedMemberId = '';
  selectedMembershipId = '';

  paymentForm: any = {
    amount: null,
    paymentMethod: 'Cash',
    paymentType: 'Membership Fee',
    transactionId: '',
    paymentDate: new Date().toISOString().slice(0, 10),
    notes: '',
    placeOfSupplyStateCode: ''
  };

  constructor(
    private paymentService: PaymentService,
    private memberService: MemberService,
    private membershipPlanService: MembershipPlanService,
    private dashboardService: DashboardService,
    private changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadPayments();
    this.loadMembers();
  }

  ngOnDestroy(): void {
    this.membershipRequest?.unsubscribe();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (
      changes['active'] &&
      !changes['active'].firstChange &&
      this.active &&
      (!this.lastLoadedAt || Date.now() - this.lastLoadedAt >= 60_000)
    ) {
      this.loadPayments();
      if (!this.membersLoading) {
        this.loadMembers();
      }
    }
  }

  // Load payment history
  loadPayments(page = this.currentPage): void {
    if (this.loading) {
      this.queuedPaymentPage = page;
      return;
    }

    this.currentPage = page;
    this.loading = true;
    this.errorMessage = '';

    this.paymentService.getPayments(page, this.pageLimit)
      .pipe(finalize(() => {
        this.loading = false;
        const queuedPage = this.queuedPaymentPage;
        this.queuedPaymentPage = undefined;

        if (queuedPage !== undefined) {
          this.loadPayments(queuedPage);
        }
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response) => {
        this.payments = response.payments || [];
        if (response.summary) {
          this.paymentSummary = response.summary;
        } else if (response.pagination) {
          this.errorMessage = 'Payment summary is unavailable. Please retry.';
          return;
        } else {
          this.errorMessage = 'Payment summary is unavailable. Please retry.';
          return;
        }
        this.paymentSummaryLoaded = true;
        this.totalPayments =
          response.pagination?.totalPayments ?? response.count ?? 0;
        this.totalPages = response.pagination?.totalPages ?? 1;
        this.currentPage = response.pagination?.currentPage ?? 1;
        this.lastLoadedAt = Date.now();
      },
      error: (error) => {
        console.error('Payments loading error:', error);
        this.errorMessage = error.error?.message || 'Unable to load payments.';
      }
    });
  }

  // Load active members
  loadMembers(): void {
    if (this.membersLoading) {
      return;
    }

    this.membersLoading = true;

    this.memberService.getAllMatchingMembers('', 'Active')
      .pipe(finalize(() => {
        this.membersLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (members) => {
        this.members = members;
      },
      error: (error) => {
        console.error('Members loading error:', error);
        this.errorMessage = 'Unable to load members.';
      }
    });
  }

  // Open payment form
  openPaymentForm(): void {
    this.showPaymentForm = true;
    this.successMessage = '';
    this.errorMessage = '';
  }

  // Close payment form
  closePaymentForm(): void {
    this.membershipRequest?.unsubscribe();
    this.membershipsLoading = false;
    this.showPaymentForm = false;
    this.selectedMemberId = '';
    this.selectedMembershipId = '';
    this.memberships = [];
    this.resetPaymentForm();
  }

  // When member changes
  onMemberChange(): void {
    this.membershipRequest?.unsubscribe();
    this.membershipRequest = undefined;
    this.selectedMembershipId = '';
    this.memberships = [];
    this.membershipsLoading = false;
    this.successMessage = '';
    this.errorMessage = '';

    if (!this.selectedMemberId) {
      return;
    }

    const memberId = this.selectedMemberId;
    this.membershipsLoading = true;

    this.membershipRequest = this.membershipPlanService
      .getMemberMemberships(memberId)
      .pipe(finalize(() => {
        if (this.selectedMemberId === memberId) {
          this.membershipsLoading = false;
        }
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: (response) => {
          if (this.selectedMemberId !== memberId) return;
          const allMemberships = response.memberships || [];

          this.memberships = allMemberships.filter((membership: any) => {
            const pendingCents =
              Math.round(Number(membership.planPrice) * 100) -
              Math.round(Number(membership.paidAmount || 0) * 100);

            return membership.status !== 'Cancelled' && pendingCents > 0;
          });

        },
        error: (error) => {
          if (this.selectedMemberId !== memberId) return;
          console.error('Membership loading error:', error);
          this.errorMessage =
            error.error?.message || 'Unable to load memberships.';
        }
      });
  }

  // Selected membership
  get selectedMembership(): any {
    return this.memberships.find(
      membership => membership._id === this.selectedMembershipId
    ) || null;
  }

  // Remaining membership fees
  get pendingAmount(): number {
    if (!this.selectedMembership) {
      return 0;
    }

    const pendingCents =
      Math.round(Number(this.selectedMembership.planPrice) * 100) -
      Math.round(Number(this.selectedMembership.paidAmount || 0) * 100);
    return Math.max(0, pendingCents) / 100;
  }

  // Select membership
  onMembershipChange(): void {
    this.paymentForm.amount = this.pendingAmount || null;
    this.paymentForm.placeOfSupplyStateCode =
      this.selectedMembership?.placeOfSupplyStateCode || '';
  }

  // Save payment
  submitPayment(): void {
    if (this.savingPayment) {
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';

    if (!this.selectedMemberId || !this.selectedMembershipId) {
      this.errorMessage = 'Please select a member and membership.';
      return;
    }

    const amount = Number(this.paymentForm.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      this.errorMessage = 'Please enter a valid payment amount.';
      return;
    }

    if (amount > this.pendingAmount) {
      this.errorMessage = 'Payment cannot exceed the pending amount.';
      return;
    }

    if (!this.paymentForm.paymentMethod) {
      this.errorMessage = 'Please select a payment method.';
      return;
    }
    if (
      this.selectedMembership?.gstSnapshot?.enabled &&
      !this.selectedMembership.placeOfSupplyStateCode &&
      !this.paymentForm.placeOfSupplyStateCode
    ) {
      this.errorMessage = 'Select the place-of-supply state for the GST invoice.';
      return;
    }

    const paymentData = {
      memberId: this.selectedMemberId,
      membershipId: this.selectedMembershipId,
      amount,
      paymentMethod: this.paymentForm.paymentMethod,
      paymentType: this.paymentForm.paymentType,
      transactionId: this.paymentForm.transactionId,
      paymentDate: this.paymentForm.paymentDate,
      notes: this.paymentForm.notes,
      placeOfSupplyStateCode: this.paymentForm.placeOfSupplyStateCode
    };

    this.savingPayment = true;

    this.paymentService.createPayment(paymentData)
      .pipe(finalize(() => {
        this.savingPayment = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response) => {
        if (response.success) {
          this.successMessage = 'Payment recorded successfully!';
          this.dashboardService.requestRefresh();

          this.closePaymentForm();
          this.loadPayments(1);
        }
      },
      error: (error) => {
        console.error('Create payment error:', error);
        this.errorMessage =
          error.error?.message || 'Unable to record payment.';
      }
    });
  }

  // Reset form fields
  resetPaymentForm(): void {
    this.paymentForm = {
      amount: null,
      paymentMethod: 'Cash',
      paymentType: 'Membership Fee',
      transactionId: '',
      paymentDate: new Date().toISOString().slice(0, 10),
      notes: '',
      placeOfSupplyStateCode: ''
    };
  }

  get totalCollection(): number {
    return this.paymentSummary.totalCollection;
  }

  get totalTransactions(): number {
    return this.paymentSummary.totalTransactions;
  }

  get pendingTransactions(): number {
    return this.paymentSummary.pendingTransactions;
  }

  get hasOutstandingSummary(): boolean {
    const value = this.paymentSummary.totalOutstanding;
    return typeof value === 'number' && Number.isFinite(value);
  }

  get totalOutstanding(): number {
    return Number(this.paymentSummary.totalOutstanding || 0);
  }

  changePage(page: number): void {
    if (page < 1 || page > this.totalPages || this.loading) {
      return;
    }

    this.loadPayments(page);
  }

  formatDate(date: string): string {
    return new Date(date).toLocaleDateString('en-IN');
  }

  generateReceipt(payment: any): void {
    this.loadReceipt(payment, 'download');
  }

  viewReceipt(payment: any): void {
    this.loadReceipt(payment, 'view');
  }

  printVerifiedReceipt(payment: any): void {
    this.loadReceipt(payment, 'print');
  }

  private loadReceipt(payment: any, action: 'view' | 'download' | 'print'): void {
    if (
      !payment?._id ||
      !['Success', 'Refunded'].includes(payment.status) ||
      this.receiptLoadingId
    ) return;

    const popup = action === 'download'
      ? null
      : window.open('', '_blank', 'width=900,height=900');
    if (action !== 'download' && !popup) {
      this.receiptErrorMessage = 'Please allow pop-ups to view or print the receipt.';
      return;
    }

    this.receiptLoadingId = payment._id;
    this.receiptErrorMessage = '';
    this.paymentService.getPaymentReceipt(payment._id)
      .pipe(finalize(() => {
        this.receiptLoadingId = '';
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          if (!response?.success || !response.receipt) {
            popup?.close();
            this.receiptErrorMessage = 'Verified receipt details were not returned.';
            return;
          }
          if (action === 'download') {
            this.createReceiptPdf(response.receipt);
          } else if (popup) {
            this.writeReceiptWindow(popup, response.receipt, action === 'print');
          }
        },
        error: error => {
          console.error('Verified receipt loading error:', error);
          popup?.close();
          this.receiptErrorMessage =
            error.error?.message || 'Unable to load the verified payment receipt.';
        }
      });
  }

  private money(value: unknown): string {
    return `INR ${Number(value || 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  private createReceiptPdf(receipt: any): void {
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const margin = 16;
    const pageWidth = pdf.internal.pageSize.getWidth();
    let y = 17;
    const line = (label: string, value: unknown, emphasize = false): void => {
      const labelWidth = 58;
      const valueLines = pdf.splitTextToSize(
        String(value || '-'),
        pageWidth - margin * 2 - labelWidth
      );
      if (y + Math.max(7, valueLines.length * 4) > 280) {
        pdf.addPage();
        y = 18;
      }
      pdf.setFont('helvetica', emphasize ? 'bold' : 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(95, 95, 95);
      pdf.text(label, margin, y);
      pdf.setTextColor(emphasize ? 181 : 40, emphasize ? 31 : 40, emphasize ? 43 : 40);
      pdf.text(valueLines, margin + labelWidth, y);
      y += Math.max(7, valueLines.length * 4);
    };
    const section = (title: string): void => {
      y += 3;
      pdf.setDrawColor(225, 225, 225);
      pdf.line(margin, y, pageWidth - margin, y);
      y += 7;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(11);
      pdf.setTextColor(37, 38, 48);
      pdf.text(title, margin, y);
      y += 7;
    };
    const formatDate = (date: string | Date) =>
      date ? new Date(date).toLocaleDateString('en-IN') : '-';

    pdf.setFillColor(181, 31, 43);
    pdf.roundedRect(margin, y, 14, 14, 2, 2, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(255, 255, 255);
    pdf.text('SS', margin + 3.2, y + 9);
    pdf.setFontSize(16);
    pdf.setTextColor(181, 31, 43);
    pdf.text(
      pdf.splitTextToSize(receipt.business?.businessName || this.appName, pageWidth - margin * 2 - 20),
      margin + 20,
      y + 6
    );
    pdf.setFontSize(8);
    pdf.setTextColor(100, 100, 100);
    pdf.text('PAYMENT RECEIPT', margin + 20, y + 12);
    y += 22;

    line('Business address', receipt.business?.address);
    line('Phone / Email', `${receipt.business?.phone || '-'} / ${receipt.business?.email || '-'}`);
    if (receipt.business?.gstinNumber) line('GSTIN', receipt.business.gstinNumber);
    section('Receipt Details');
    line('Receipt number', receipt.receiptNumber);
    line('Receipt date', formatDate(receipt.receiptDate));
    line('Transaction ID', receipt.payment?.transactionId);
    line('Payment method', receipt.payment?.paymentMethod);
    line('Payment date', formatDate(receipt.paymentDate));
    section('Member Details');
    line('Member name', receipt.member?.fullName);
    line('Member ID', receipt.member?.id);
    line('Phone number', receipt.member?.phone);
    line('Membership plan', receipt.membership?.planName);
    section('Payment Summary');
    line('Total membership fees', this.money(receipt.summary?.totalMembershipFees));
    line('Amount received this transaction', this.money(receipt.payment?.amountReceived), true);
    line('Total amount paid', this.money(receipt.summary?.totalAmountPaid));
    line('Pending amount', this.money(receipt.summary?.pendingAmount), true);
    line('Payment status', receipt.summary?.status, true);

    if (receipt.taxInvoice) {
      section(`GST Tax Invoice · ${receipt.taxInvoice.invoiceNumber}`);
      line('Invoice date', formatDate(receipt.taxInvoice.issueDate));
      line('Legal business name', receipt.taxInvoice.legalBusinessName);
      line('Taxable amount', this.money(receipt.taxInvoice.taxableAmount));
      line('GST rate', `${receipt.taxInvoice.gstPercentage}%`);
      line('Place of supply', `${receipt.taxInvoice.placeOfSupplyStateCode} (${receipt.taxInvoice.componentMode})`);
      if (receipt.taxInvoice.componentMode === 'IGST') {
        line('IGST', this.money(receipt.taxInvoice.igst));
      } else {
        line('CGST', this.money(receipt.taxInvoice.cgst));
        line('SGST', this.money(receipt.taxInvoice.sgst));
      }
      line('Total GST', this.money(receipt.taxInvoice.totalTax));
      line('Tax invoice total', this.money(receipt.taxInvoice.totalAmount), true);
    }

    if (receipt.currentPaymentStatus) {
      y += 2;
      line('Current balance (updated)', this.money(receipt.currentPaymentStatus.pendingAmount));
    }
    y += 7;
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(9);
    pdf.setTextColor(100, 100, 100);
    pdf.text('Thank you for being a member of our gym.', margin, y);
    if (receipt.taxInvoice) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.text('Payment receipt confirms money received; the GST tax invoice records the taxable supply.', margin, y + 5);
    }
    pdf.save(`receipt-${String(receipt.receiptNumber || 'payment').replace(/[^A-Za-z0-9_-]/g, '')}.pdf`);
  }

  private writeReceiptWindow(popup: Window, receipt: any, autoPrint: boolean): void {
    const escape = (value: unknown) => this.escapeHtml(value);
    const business = receipt.business || {};
    const payment = receipt.payment || {};
    const member = receipt.member || {};
    const summary = receipt.summary || {};
    const invoice = receipt.taxInvoice;
    const safeLogoUrl = /^https:\/\//i.test(String(business.logoUrl || ''))
      ? business.logoUrl
      : '';
    const row = (label: string, value: unknown, highlight = false) =>
      `<div class="row ${highlight ? 'highlight' : ''}"><span>${escape(label)}</span><strong>${escape(value || '-')}</strong></div>`;
    const formatDate = (date: string | Date) =>
      date ? new Date(date).toLocaleDateString('en-IN') : '-';
    const invoiceRows = invoice
      ? [
          row('Invoice number', invoice.invoiceNumber),
          row('Invoice date', formatDate(invoice.issueDate)),
          row('Legal business name', invoice.legalBusinessName),
          row('GSTIN', invoice.gstinNumber),
          row('Taxable amount', this.money(invoice.taxableAmount)),
          row('GST rate', `${invoice.gstPercentage}%`),
          row('Place of supply', `${invoice.placeOfSupplyStateCode} · ${invoice.componentMode}`),
          invoice.componentMode === 'IGST'
            ? row('IGST', this.money(invoice.igst))
            : `${row('CGST', this.money(invoice.cgst))}${row('SGST', this.money(invoice.sgst))}`,
          row('Total GST', this.money(invoice.totalTax)),
          row('Tax invoice total', this.money(invoice.totalAmount), true)
        ].join('')
      : '';

    popup.document.open();
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8">
      <title>Payment Receipt ${escape(receipt.receiptNumber)}</title>
      <style>
        *{box-sizing:border-box}body{margin:0;padding:28px;background:#f4f5f7;color:#252525;font:14px Arial,sans-serif}
        .receipt{max-width:760px;margin:auto;background:#fff;padding:36px;border:1px solid #e6e6e6}
        header{display:flex;align-items:center;gap:15px;border-bottom:3px solid #b51f2b;padding-bottom:18px}
        header img{max-width:70px;max-height:60px;object-fit:contain}header h1{margin:0 0 5px;color:#b51f2b;font-size:23px}
        .subtitle{font-size:11px;color:#777;letter-spacing:1px}.section{margin-top:22px}
        .section h2{margin:0 0 8px;padding-bottom:8px;border-bottom:1px solid #e7e7e7;font-size:14px}
        .row{display:flex;justify-content:space-between;gap:18px;padding:8px 0;border-bottom:1px solid #f0f0f0}
        .row span{color:#777}.row strong{text-align:right;overflow-wrap:anywhere}.highlight{color:#b51f2b;background:#fff7f6;padding:10px}
        .footer{text-align:center;margin-top:30px;color:#777;font-size:12px}.actions{text-align:center;margin:20px auto}
        .actions button{padding:10px 18px;border:0;border-radius:6px;background:#b51f2b;color:#fff;cursor:pointer}
        .notice{font-size:11px;color:#777}@media print{body{padding:0;background:#fff}.receipt{border:0}.actions{display:none}@page{size:A4;margin:14mm}}
      </style></head><body><main class="receipt">
      <header>${safeLogoUrl ? `<img src="${escape(safeLogoUrl)}" alt="Business logo">` : '<div style="background:#b51f2b;color:#fff;padding:12px 15px;border-radius:8px;font-weight:bold">SS</div>'}
        <div><h1>${escape(business.businessName || this.appName)}</h1>
        <div class="subtitle">PAYMENT RECEIPT · ${escape(business.address || '')}</div>
        <div class="subtitle">${escape(business.phone || '')} ${escape(business.email || '')}</div>
        ${business.gstinNumber ? `<div class="subtitle">GSTIN: ${escape(business.gstinNumber)}</div>` : ''}</div>
      </header>
      <section class="section"><h2>Receipt details</h2>
        ${row('Receipt number', receipt.receiptNumber)}
        ${row('Receipt date', formatDate(receipt.receiptDate))}
        ${row('Transaction ID', payment.transactionId)}
        ${row('Payment method', payment.paymentMethod)}
        ${row('Payment date', formatDate(receipt.paymentDate))}
      </section>
      <section class="section"><h2>Member details</h2>
        ${row('Member name', member.fullName)}${row('Member ID', member.id)}
        ${row('Phone number', member.phone)}${row('Membership plan', receipt.membership?.planName)}
      </section>
      <section class="section"><h2>Payment summary</h2>
        ${row('Total membership fees', this.money(summary.totalMembershipFees))}
        ${row('Amount received this transaction', this.money(payment.amountReceived), true)}
        ${row('Total amount paid', this.money(summary.totalAmountPaid))}
        ${row('Pending amount', this.money(summary.pendingAmount), true)}
        ${row('Payment status', summary.status, true)}
      </section>
      ${invoice ? `<section class="section"><h2>GST Tax Invoice</h2>${invoiceRows}</section>` : ''}
      <footer class="footer"><p>Thank you for being a member of our gym.</p>
        <p class="notice">Payment receipt confirms money received${invoice ? '; the GST tax invoice records the taxable supply.' : '.'}</p></footer>
      </main><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
      </body></html>`);
    popup.document.close();
    if (autoPrint) {
      popup.focus();
      popup.print();
    }
  }

  // Escape dynamic values before inserting them into receipt HTML
  escapeHtml(value: any): string {
    return String(value ?? '').replace(/[&<>"']/g, (char) => {
      const entities: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      };

      return entities[char];
    });
  }

  // Print Payment Receipt
  printReceipt(payment: any): void {
    this.printVerifiedReceipt(payment);
    return;

    if (!payment || payment.status !== 'Success') {
      return;
    }

    const business = JSON.parse(
      localStorage.getItem('business') || '{}'
    );

    const businessName = this.escapeHtml(
      business.businessName || 'SS FITNESS'
    );

    const memberName = this.escapeHtml(
      payment.memberId?.fullName || 'Member'
    );

    const memberPhone = this.escapeHtml(
      payment.memberId?.phone || '-'
    );

    const receiptNumber = this.escapeHtml(
      payment.receiptNumber || '-'
    );

    const paymentMethod = this.escapeHtml(
      payment.paymentMethod || '-'
    );

    const paymentType = this.escapeHtml(
      payment.paymentType || 'Membership Fee'
    );

    const transactionId = this.escapeHtml(
      payment.transactionId || '-'
    );

    const notes = this.escapeHtml(payment.notes || '-');

    const amount = Number(payment.amount || 0);

    const formattedAmount = amount.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });

    const formattedDate = this.escapeHtml(
      this.formatDate(payment.paymentDate)
    );

    const popup = window.open('', '_blank', 'width=800,height=900');

    if (!popup) {
      alert('Please allow pop-ups to print your receipt.');
      return;
    }
    const receiptPopup = popup!;

    const receiptHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Payment Receipt - ${receiptNumber}</title>

        <style>
          * {
            box-sizing: border-box;
          }

          body {
            font-family: Arial, sans-serif;
            background: #f4f4f4;
            padding: 30px;
            color: #222;
          }

          .receipt {
            max-width: 650px;
            margin: auto;
            background: #fff;
            padding: 40px;
            border: 1px solid #ddd;
          }

          .header {
            text-align: center;
            border-bottom: 3px solid #e53935;
            padding-bottom: 20px;
          }

          .logo {
            display: inline-block;
            background: #e53935;
            color: #fff;
            font-size: 25px;
            font-weight: bold;
            padding: 12px 18px;
            border-radius: 10px;
          }

          h1 {
            margin: 12px 0 5px;
            font-size: 25px;
          }

          .subtitle {
            color: #777;
            font-size: 12px;
          }

          .paid {
            display: inline-block;
            background: #e8f7ef;
            color: #16834b;
            padding: 7px 18px;
            border-radius: 20px;
            font-weight: bold;
            margin-top: 15px;
          }

          .section {
            margin-top: 25px;
          }

          .section h3 {
            font-size: 14px;
            border-bottom: 1px solid #ddd;
            padding-bottom: 10px;
          }

          .row {
            display: flex;
            justify-content: space-between;
            gap: 15px;
            padding: 11px 0;
            border-bottom: 1px solid #eee;
            font-size: 13px;
          }

          .row span:first-child {
            color: #777;
          }

          .amount {
            margin-top: 25px;
            background: #fff5f5;
            padding: 20px;
            text-align: center;
            border-radius: 8px;
          }

          .amount strong {
            display: block;
            font-size: 30px;
            color: #e53935;
            margin-top: 8px;
          }

          .footer {
            text-align: center;
            margin-top: 35px;
            color: #777;
            font-size: 12px;
          }

          .print-btn {
            display: block;
            margin: 25px auto;
            background: #e53935;
            color: white;
            padding: 12px 25px;
            border: none;
            border-radius: 7px;
            cursor: pointer;
          }

          @media print {
            body {
              background: #fff;
              padding: 0;
            }

            .receipt {
              border: none;
            }

            .print-btn {
              display: none;
            }

            @page {
              size: A4;
              margin: 15mm;
            }
          }
        </style>
      </head>

      <body>

        <div class="receipt">

          <div class="header">
            <div class="logo">SS</div>
            <h1>${businessName}</h1>
            <div class="subtitle">
              ${this.appName.toUpperCase()} · PAYMENT RECEIPT
            </div>
            <span class="paid">PAYMENT SUCCESSFUL</span>
          </div>

          <div class="section">
            <h3>Receipt Details</h3>

            <div class="row">
              <span>Receipt Number</span>
              <strong>${receiptNumber}</strong>
            </div>

            <div class="row">
              <span>Payment Date</span>
              <strong>${formattedDate}</strong>
            </div>
          </div>

          <div class="section">
            <h3>Member Details</h3>

            <div class="row">
              <span>Member Name</span>
              <strong>${memberName}</strong>
            </div>

            <div class="row">
              <span>Phone Number</span>
              <strong>${memberPhone}</strong>
            </div>
          </div>

          <div class="section">
            <h3>Payment Details</h3>

            <div class="row">
              <span>Payment Type</span>
              <strong>${paymentType}</strong>
            </div>

            <div class="row">
              <span>Payment Method</span>
              <strong>${paymentMethod}</strong>
            </div>

            <div class="row">
              <span>Transaction ID</span>
              <strong>${transactionId}</strong>
            </div>

            <div class="row">
              <span>Notes</span>
              <strong>${notes}</strong>
            </div>
          </div>

          <div class="amount">
            Amount Received
            <strong>₹${formattedAmount}</strong>
          </div>

          <div class="footer">
            <h3>Thank You!</h3>
            <p>Thank you for choosing ${businessName}.</p>
            <p>Computer generated payment receipt.</p>
            <p>Powered by SS Builds365</p>
          </div>

        </div>

        <button class="print-btn" onclick="window.print()">
          Print / Save as PDF
        </button>

      </body>
      </html>
    `;

    receiptPopup.document.open();
    receiptPopup.document.write(receiptHTML);
    receiptPopup.document.close();
  }

}
