import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, KeyboardAvoidingView, Modal,
  Platform, RefreshControl, ScrollView, StyleSheet, Text,
  TextInput, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius, Shadows } from '../constants/theme';
import { getShopNow, DEFAULT_TZ, minutesSinceServerDate, minutesUntilShopDateTime, formatTimeString } from '../utils/datetime';
import DateTimePickerModal from '../components/DateTimePickerModal';
import { generateDeliverySlip, generatePickupSlip } from '../utils/printHelpers';

/* ─── PALETTE (derives from existing app theme) ───────────── */
const P = {
  // Inherits brand colors
  pink:       Colors.primary,       // #E91E63
  pinkLight:  Colors.primaryLight,  // #FBCFE8
  pinkGlow:   Colors.primaryGlow,   // #FDF2F8
  green:      Colors.secondary,     // #10B981
  greenLight: Colors.secondaryLight,// #D1FAE5
  amber:      Colors.warning,       // #F59E0B
  amberLight: Colors.warningLight,  // #FEF3C7
  red:        Colors.error,         // #EF4444
  redLight:   Colors.errorLight,    // #FEE2E2
  blue:       Colors.info,          // #3B82F6
  blueLight:  Colors.infoLight,     // #DBEAFE
  // Surfaces
  bg:         Colors.background,    // #FAFAFA
  surface:    Colors.surface,       // #FFFFFF
  surfaceAlt: Colors.surfaceAlt,    // #F9FAFB
  border:     Colors.border,        // #E5E7EB
  // Text
  text:       Colors.text,          // #111827
  textSec:    Colors.textSecondary, // #4B5563
  textMuted:  Colors.textLight,     // #9CA3AF
  // Lane colors per order type
  delivery:   Colors.info,
  pickup:     Colors.secondary,
  walk_in:    Colors.primary,
};

const TYPE_COLOR = { delivery: P.blue, pickup: P.green, walk_in: P.pink };
const TYPE_ICON  = { delivery: 'bicycle-outline', pickup: 'bag-handle-outline', walk_in: 'storefront-outline' };
const TYPE_BG    = { delivery: P.blueLight, pickup: P.greenLight, walk_in: P.pinkLight };
const TYPE_LABEL = { delivery: 'Delivery', pickup: 'Pickup', walk_in: 'Walk-in' };

const STATUS_LABEL  = { pending:'Pending', confirmed:'Confirmed', preparing:'Preparing', ready:'Ready', completed:'Completed', cancelled:'Cancelled' };
const STATUS_COLOR  = { pending: P.amber, confirmed: P.amber, preparing: P.blue, ready: P.green, completed: P.green, cancelled: P.textMuted };
const TASK_STATUS   = { pending:'Queued', assigned:'Assigned', in_progress:'In Progress', completed:'Done', cancelled:'Cancelled' };
const TASK_COLOR    = (s) => s==='completed'?P.green:s==='in_progress'?P.blue:s==='assigned'?P.pink:s==='pending'?P.amber:P.textMuted;
const DELIV_LABEL   = { pending:'Pending', assigned:'Assigned', picked_up:'Picked Up', in_transit:'In Transit', delivered:'Delivered', failed:'Failed', cancelled:'Cancelled' };
const DELIV_COLOR   = { pending:P.textMuted, assigned:P.blue, picked_up:P.amber, in_transit:P.blue, delivered:P.green, failed:P.red, cancelled:P.textMuted };
const PAY_COLOR     = { paid:P.green, partial:P.amber, pending:P.red, refunded:P.textMuted };
const PICKUP_LABEL  = { waiting:'Waiting', ready_for_pickup:'Ready to Collect', picked_up:'Picked Up' };
const PICKUP_COLOR  = { waiting:P.amber, ready_for_pickup:P.green, picked_up:P.blue };

const LANE_DEFS = {
  delivery: [
    { key:'pending',    label:'Pending',         hint:'Confirmed + Pending' },
    { key:'preparing',  label:'Preparing',        hint:'In production' },
    { key:'ready',      label:'Ready to Dispatch',hint:'Awaiting dispatch' },
    { key:'in_transit', label:'In Transit',        hint:'Out for delivery' },
  ],
  pickup: [
    { key:'pending',   label:'Pending',   hint:'' },
    { key:'preparing', label:'Preparing', hint:'' },
    { key:'ready',     label:'Ready',     hint:'' },
  ],
  walk_in: [
    { key:'pending',   label:'Pending',   hint:'' },
    { key:'preparing', label:'Preparing', hint:'' },
    { key:'ready',     label:'Ready',     hint:'' },
  ],
};

function fmt(v) { return `₹${Number(v||0).toLocaleString('en-IN',{maximumFractionDigits:0})}`; }

function normalizePhase(s) { return s==='confirmed'?'pending':s==='completed'?'ready':s; }

function getOrderSla(order, tz) {
  if (!order||['ready','completed','cancelled','draft'].includes(order.status)) return null;
  if (order.order_type==='walk_in') {
    const d=minutesSinceServerDate(order.created_at,tz);
    if(d==null)return null;
    return d>20?'overdue':d>10?'dueSoon':null;
  }
  if (!order.scheduled_date||!order.scheduled_time) return null;
  const r=minutesUntilShopDateTime(order.scheduled_date,order.scheduled_time,tz);
  if(r==null)return null;
  return r<0?'overdue':r<=60?'dueSoon':null;
}

function formatCardDT(dateStr, timeStr, tz) {
  try {
    if (!dateStr) return '';
    let ld = dateStr;
    if (dateStr.includes('T')||dateStr.includes('Z')||dateStr.includes('+')) {
      const d=new Date(dateStr); if(!isNaN(d.getTime())) ld=d.toLocaleDateString('en-CA',{timeZone:tz||DEFAULT_TZ});
    }
    const [,m,day]=ld.split('-').map(Number);
    const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dp=`${day} ${months[m-1]}`;
    return timeStr ? `${dp}, ${formatTimeString(timeStr)}` : dp;
  } catch { return dateStr||''; }
}

/* ─── KPI CHIP ────────────────────────────────────────────── */
function KpiChip({ icon, label, value, color, bg }) {
  return (
    <View style={[ks.chip, { backgroundColor: bg, borderColor: color+'30' }]}>
      <Ionicons name={icon} size={16} color={color} />
      <Text style={[ks.val, { color }]}>{value}</Text>
      <Text style={ks.lbl}>{label}</Text>
    </View>
  );
}
const ks = StyleSheet.create({
  chip: { flex:1, alignItems:'center', gap:3, paddingVertical:10, paddingHorizontal:6, borderRadius:12, borderWidth:1 },
  val: { fontSize:18, fontWeight:'800' },
  lbl: { fontSize:10, fontWeight:'600', color:Colors.textSecondary, textAlign:'center' },
});
/* ─── ORDER CARD (in lane) ────────────────────────────────── */
function OrderCard({ order, tasks, onPress, timezone }) {
  const sla = getOrderSla(order, timezone);
  const sc  = STATUS_COLOR[order.status] || P.textMuted;
  const tc  = TYPE_COLOR[order.order_type] || P.pink;
  const tasksDone  = tasks.filter(t=>t.status==='completed').length;
  const tasksTotal = tasks.length;
  const isCredit   = order.is_credit_sale===1;
  const payColor   = isCredit ? P.blue : (PAY_COLOR[order.payment_status]||P.textMuted);
  const overdue    = sla==='overdue';

  return (
    <TouchableOpacity
      style={[cs.card, { borderLeftColor: tc }, overdue && cs.cardOverdue]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      {/* Header row */}
      <View style={cs.row}>
        <View style={{flex:1}}>
          <Text style={cs.num}>#{order.sale_number}</Text>
          <Text style={cs.customer} numberOfLines={1}>{order.customer_name||'Guest'}</Text>
        </View>
        <View style={{alignItems:'flex-end',gap:2}}>
          <Text style={cs.amount}>{fmt(order.grand_total)}</Text>
          <View style={[cs.badge,{backgroundColor:sc+'18'}]}>
            <Text style={[cs.badgeTxt,{color:sc}]}>{(STATUS_LABEL[order.status]||order.status).toUpperCase()}</Text>
          </View>
        </View>
      </View>

      {/* SLA warning */}
      {sla && (
        <View style={[cs.slaRow,{backgroundColor:overdue?Colors.errorLight:Colors.warningLight}]}>
          <Ionicons name={overdue?'alert-circle':'time-outline'} size={10} color={overdue?P.red:P.amber}/>
          <Text style={[cs.slaTxt,{color:overdue?P.red:P.amber}]}>{overdue?'OVERDUE':'DUE SOON'}</Text>
        </View>
      )}

      {/* Scheduled date */}
      {order.scheduled_date && (
        <View style={cs.schedRow}>
          <Ionicons name="calendar-outline" size={10} color={P.pink}/>
          <Text style={cs.schedTxt}>{formatCardDT(order.scheduled_date,order.scheduled_time,timezone)}</Text>
        </View>
      )}

      {/* Payment badge if not clean */}
      {(isCredit||(order.payment_status&&order.payment_status!=='paid')) && (
        <View style={[cs.badge,{backgroundColor:payColor+'18',alignSelf:'flex-start',marginTop:3}]}>
          <Text style={[cs.badgeTxt,{color:payColor}]}>{isCredit?'CREDIT':order.payment_status==='pending'?'UNPAID':'PARTIAL'}</Text>
        </View>
      )}

      {/* Task progress bar */}
      {tasksTotal>0 && (
        <View style={cs.progressWrap}>
          <View style={[cs.progressBar,{width:tasksTotal>0?`${Math.round(tasksDone/tasksTotal*100)}%`:'0%'}]}/>
          <Text style={cs.progressTxt}>{tasksDone}/{tasksTotal}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const cs = StyleSheet.create({
  card: { backgroundColor:P.surface, borderRadius:10, borderWidth:1, borderColor:P.border, borderLeftWidth:4, padding:10, marginBottom:6, ...Shadows.sm },
  cardOverdue: { borderColor: Colors.error+'50' },
  row: { flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4 },
  num: { fontSize:13, fontWeight:'800', color:P.text },
  customer: { fontSize:11, color:P.textSec, marginTop:1 },
  amount: { fontSize:13, fontWeight:'800', color:P.green },
  badge: { paddingHorizontal:6, paddingVertical:2, borderRadius:5 },
  badgeTxt: { fontSize:9, fontWeight:'800' },
  slaRow: { flexDirection:'row', alignItems:'center', gap:3, paddingHorizontal:5, paddingVertical:2, borderRadius:5, alignSelf:'flex-start', marginBottom:3 },
  slaTxt: { fontSize:9, fontWeight:'800' },
  schedRow: { flexDirection:'row', alignItems:'center', gap:3, marginBottom:2 },
  schedTxt: { fontSize:10, color:P.pink, fontWeight:'600' },
  progressWrap: { height:14, backgroundColor:P.surfaceAlt, borderRadius:7, overflow:'hidden', justifyContent:'center', marginTop:5 },
  progressBar: { position:'absolute', left:0, top:0, bottom:0, backgroundColor:P.green+'50', borderRadius:7 },
  progressTxt: { fontSize:9, color:P.textSec, fontWeight:'700', textAlign:'center' },
});

/* ─── LANE COLUMN ─────────────────────────────────────────── */
function LaneColumn({ lane, orders, tasks, timezone, typeColor, onPressOrder, onViewAll }) {
  const overdueCount = orders.filter(o=>getOrderSla(o,timezone)==='overdue').length;
  const dueSoonCount = orders.filter(o=>getOrderSla(o,timezone)==='dueSoon').length;
  const preview = orders.slice(0,4);

  return (
    <View style={lc.col}>
      <View style={lc.header}>
        <Text style={lc.title}>{lane.label}</Text>
        <View style={{flexDirection:'row',alignItems:'center',gap:5}}>
          {overdueCount>0&&<View style={[lc.slaChip,{backgroundColor:Colors.errorLight}]}><Text style={[lc.slaTxt,{color:P.red}]}>{overdueCount}!</Text></View>}
          <View style={[lc.countChip,{backgroundColor:typeColor+'18'}]}>
            <Text style={[lc.countTxt,{color:typeColor}]}>{orders.length}</Text>
          </View>
        </View>
      </View>
      {dueSoonCount>0&&<View style={[lc.hint,{backgroundColor:P.amberLight}]}>
        <Ionicons name="time-outline" size={10} color={P.amber}/>
        <Text style={[lc.hintTxt,{color:P.amber}]}>{dueSoonCount} due soon</Text>
      </View>}
      {orders.length===0 ? (
        <View style={lc.empty}><Text style={lc.emptyTxt}>All clear</Text></View>
      ) : (
        <>
          {preview.map(o=>(
            <OrderCard key={o.id} order={o} tasks={tasks.get(o.id)||[]} timezone={timezone} onPress={()=>onPressOrder(o)}/>
          ))}
          {orders.length>4&&(
            <TouchableOpacity style={lc.viewMore} onPress={onViewAll}>
              <Text style={[lc.viewMoreTxt,{color:typeColor}]}>+{orders.length-4} more →</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const lc = StyleSheet.create({
  col: { flex:1, minWidth:0 },
  header: { flexDirection:'row', justifyContent:'space-between', alignItems:'center', marginBottom:8, paddingHorizontal:2 },
  title: { fontSize:12, fontWeight:'800', color:P.text, textTransform:'uppercase', letterSpacing:0.5 },
  countChip: { paddingHorizontal:7, paddingVertical:2, borderRadius:10 },
  countTxt: { fontSize:11, fontWeight:'800' },
  slaChip: { paddingHorizontal:5, paddingVertical:2, borderRadius:5 },
  slaTxt: { fontSize:9, fontWeight:'800' },
  hint: { flexDirection:'row', alignItems:'center', gap:3, paddingHorizontal:6, paddingVertical:3, borderRadius:6, marginBottom:6 },
  hintTxt: { fontSize:9, fontWeight:'700' },
  empty: { paddingVertical:14, alignItems:'center' },
  emptyTxt: { fontSize:11, color:P.textMuted, fontStyle:'italic' },
  viewMore: { paddingVertical:8, alignItems:'center' },
  viewMoreTxt: { fontSize:11, fontWeight:'700' },
});

/* ─── ORDER TYPE SECTION (header + lanes) ─────────────────── */
function TypeSection({ orderType, laneBuckets, tasksBySaleId, timezone, isWide, onPressOrder, onViewAll }) {
  const color  = TYPE_COLOR[orderType];
  const bg     = TYPE_BG[orderType];
  const icon   = TYPE_ICON[orderType];
  const label  = TYPE_LABEL[orderType];
  const lanes  = LANE_DEFS[orderType] || [];
  const total  = Object.values(laneBuckets).reduce((s,a)=>s+a.length,0);

  return (
    <View style={ts.section}>
      {/* Type header */}
      <View style={[ts.typeHeader, { backgroundColor: bg, borderColor: color+'30' }]}>
        <View style={[ts.iconWrap, { backgroundColor: color }]}>
          <Ionicons name={icon} size={15} color="#fff" />
        </View>
        <Text style={[ts.typeLabel, { color }]}>{label}</Text>
        <View style={[ts.typeBadge, { backgroundColor: color }]}>
          <Text style={ts.typeBadgeTxt}>{total}</Text>
        </View>
      </View>

      {/* Lane columns — horizontal on wide, stacked on narrow */}
      <View style={[ts.lanesRow, isWide && ts.lanesRowWide]}>
        {lanes.map((lane, i) => (
          <View key={lane.key} style={[ts.laneWrap, isWide && ts.laneWrapWide, i>0 && isWide && ts.laneWithDivider]}>
            <LaneColumn
              lane={lane}
              orders={laneBuckets[lane.key]||[]}
              tasks={tasksBySaleId}
              timezone={timezone}
              typeColor={color}
              onPressOrder={onPressOrder}
              onViewAll={()=>onViewAll(orderType, lane.key)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

const ts = StyleSheet.create({
  section: { backgroundColor:P.surface, borderRadius:14, borderWidth:1, borderColor:P.border, overflow:'hidden', ...Shadows.sm, marginBottom:12 },
  typeHeader: { flexDirection:'row', alignItems:'center', gap:8, paddingHorizontal:14, paddingVertical:10, borderBottomWidth:1, borderBottomColor:P.border },
  iconWrap: { width:26, height:26, borderRadius:7, alignItems:'center', justifyContent:'center' },
  typeLabel: { fontWeight:'800', fontSize:14, flex:1 },
  typeBadge: { paddingHorizontal:8, paddingVertical:2, borderRadius:99 },
  typeBadgeTxt: { color:'#fff', fontWeight:'800', fontSize:11 },
  lanesRow: { padding:10, gap:0 },
  lanesRowWide: { flexDirection:'row', gap:0 },
  laneWrap: { paddingHorizontal:6, paddingVertical:8 },
  laneWrapWide: { flex:1 },
  laneWithDivider: { borderLeftWidth:1, borderLeftColor:P.border },
});
/* ─── DETAIL PANEL (reuses OrderQuickModal pattern but inline) ── */
function DetailPanel({ order, tasks, onClose, onRefresh, navigation, canManage, tz }) {
  const [localTasks, setLocalTasks] = useState(tasks||[]);
  const [actionLoading, setActionLoading] = useState(false);
  const [taskLoading, setTaskLoading] = useState({});
  const [delivInfo, setDelivInfo] = useState(null);
  const [delivLoading, setDelivLoading] = useState(false);
  const [showAssign, setShowAssign] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [empLoading, setEmpLoading] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(null);
  const [confirmTask, setConfirmTask] = useState(null);
  const [showPartnerPick, setShowPartnerPick] = useState(false);
  const [partners, setPartners] = useState([]);
  const [partnersLoading, setPartnersLoading] = useState(false);
  const [delivActionLoading, setDelivActionLoading] = useState(false);
  const [showCodForm, setShowCodForm] = useState(false);
  const [showFailForm, setShowFailForm] = useState(false);
  const [codAmount, setCodAmount] = useState('');
  const [codMethod, setCodMethod] = useState('cash');
  const [failReason, setFailReason] = useState('');
  const [showPayForm, setShowPayForm] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [payLoading, setPayLoading] = useState(false);

  useEffect(()=>{setLocalTasks(tasks||[]);},[tasks]);
  useEffect(()=>{
    if(order?.order_type==='delivery'&&order?.id){setDelivLoading(true);api.getSale(order.id).then(r=>setDelivInfo(r?.data?.delivery||null)).catch(()=>setDelivInfo(null)).finally(()=>setDelivLoading(false));}
    else setDelivInfo(null);
    setShowAssign(null);setConfirmStatus(null);setConfirmTask(null);setShowPartnerPick(false);setShowCodForm(false);setShowFailForm(false);setFailReason('');setShowPayForm(false);setPayAmount('');
  },[order?.id,order?.order_type]);

  const refreshTasks=useCallback(async()=>{if(!order?.id)return;try{const r=await api.getProductionTasks({sale_id:order.id});setLocalTasks(r?.data||[]);}catch{}},[order?.id]);
  const doStatus=useCallback(async(next)=>{if(!order?.id)return;setActionLoading(true);try{await api.updateOrderStatus(order.id,next);onRefresh?.();onClose();}catch(e){const msg=e?.message||"Failed";Platform.OS==="web"?window.alert(msg):Alert.alert("Error",msg);}finally{setActionLoading(false);}},[order?.id,onRefresh,onClose]);
  const confirmAction=useCallback((next)=>{if(next==='pay'){setShowPayForm(true); setPayAmount(dueAmt > 0 ? dueAmt.toString() : ''); return;}if(confirmStatus===next){setConfirmStatus(null);doStatus(next);}else{setConfirmStatus(next);setTimeout(()=>setConfirmStatus(null),3000);}},[doStatus,confirmStatus]);

  const openEmpPicker=useCallback(async(tid)=>{setShowAssign(tid);setEmpLoading(true);try{const r=await api.getUsers();const a=r?.data?.users||r?.data||[];setEmployees(Array.isArray(a)?a.filter(u=>['owner','manager','employee'].includes(u.role)):[]);}catch{setEmployees([]);}finally{setEmpLoading(false);}},[]);
  const doTaskAssign=useCallback(async(tid,eid)=>{setTaskLoading(p=>({...p,[tid]:true}));try{await api.assignTask(tid,{assigned_to:eid});setShowAssign(null);await refreshTasks();onRefresh?.();}catch(e){const msg=e?.message||"Failed";Platform.OS==="web"?window.alert(msg):Alert.alert("Error",msg);}finally{setTaskLoading(p=>({...p,[tid]:false}));}},[onRefresh,refreshTasks]);
  const doTaskStart=useCallback(async(tid)=>{setTaskLoading(p=>({...p,[tid]:true}));try{await api.startTask(tid);await refreshTasks();onRefresh?.();}catch(e){const msg=e?.message||"Failed";Platform.OS==="web"?window.alert(msg):Alert.alert("Error",msg);}finally{setTaskLoading(p=>({...p,[tid]:false}));}},[onRefresh,refreshTasks]);
  const doTaskComplete=useCallback(async(tid)=>{if(confirmTask===tid){setConfirmTask(null);setTaskLoading(p=>({...p,[tid]:true}));try{await api.completeTask(tid);await refreshTasks();onRefresh?.();}catch(e){const msg=e?.message||"Failed";Platform.OS==="web"?window.alert(msg):Alert.alert("Error",msg);}finally{setTaskLoading(p=>({...p,[tid]:false}));}}else{setConfirmTask(tid);setTimeout(()=>setConfirmTask(null),3000);}},[confirmTask,onRefresh,refreshTasks]);

  const openPartnerPick=async()=>{setPartnersLoading(true);setShowPartnerPick(true);try{const r=await api.getUsers({role:'delivery_partner',limit:100});const u=r?.data?.users||r?.data||[];setPartners(Array.isArray(u)?u.filter(x=>x.is_active):[]);}catch{setPartners([]);}finally{setPartnersLoading(false);}};
  const doPartnerAssign=async(pid)=>{if(!delivInfo?.id)return;setDelivActionLoading(true);try{await api.assignDelivery(delivInfo.id,{delivery_partner_id:pid});setShowPartnerPick(false);const r=await api.getSale(order.id);setDelivInfo(r?.data?.delivery||null);onRefresh?.();}catch(e){const msg=e?.message||"Failed";Platform.OS==="web"?window.alert(msg):Alert.alert("Error",msg);}finally{setDelivActionLoading(false);}};
  const doDelivAction=async(action,data={})=>{if(!delivInfo?.id)return;setDelivActionLoading(true);try{if(action==='pickup')await api.pickupDelivery(delivInfo.id);else if(action==='in_transit')await api.markInTransit(delivInfo.id);else if(action==='deliver')await api.deliverOrder(delivInfo.id,data);else if(action==='fail')await api.failDelivery(delivInfo.id,data);else if(action==='reattempt')await api.reattemptDelivery(delivInfo.id);const r=await api.getSale(order.id);setDelivInfo(r?.data?.delivery||null);onRefresh?.();setShowCodForm(false);setShowFailForm(false);}catch(e){const msg=e?.message||"Failed";Platform.OS==="web"?window.alert(msg):Alert.alert("Error",msg);}finally{setDelivActionLoading(false);}};
  const handleDeliver=()=>{const data={};if(delivInfo?.cod_amount>0){const a=parseFloat(codAmount);if(isNaN(a)||a<0){Alert.alert('Error','Enter valid COD amount');return;}data.cod_collected=a;data.cod_method=codMethod;}doDelivAction('deliver',data);};
  
  const handleCollectPayment=async()=>{
    const a = parseFloat(payAmount);
    if(isNaN(a)||a<=0){ Platform.OS==='web'?window.alert('Enter valid amount'):Alert.alert('Error','Enter valid amount'); return; }
    setPayLoading(true);
    try {
      await api.addPaymentToSale(order.id, { amount: a, method: payMethod, location_id: order.location_id });
      setShowPayForm(false);
      setPayAmount('');
      onRefresh?.();
      // Optional: Close or refresh the panel. The parent list will refresh.
    } catch(e) {
      const msg=e?.message||'Failed';
      Platform.OS==='web'?window.alert(msg):Alert.alert('Error',msg);
    } finally {
      setPayLoading(false);
    }
  };

  
  const handleResolveBalance=async(action)=>{
    setPayLoading(true);
    try {
      await api.resolveSaleBalance(order.id, { action });
      setShowPayForm(false);
      onRefresh?.();
      Platform.OS==='web'?window.alert('Success!'):Alert.alert('Success','Balance resolved.');
    } catch(e) {
      const msg=e?.message||'Failed';
      Platform.OS==='web'?window.alert(msg):Alert.alert('Error',msg);
    } finally {
      setPayLoading(false);
    }
  };

  const handleFail=()=>{if(!failReason.trim()){Alert.alert('Error','Enter failure reason');return;}doDelivAction('fail',{failure_reason:failReason.trim()});};

  if(!order)return null;
  const st=order.status||'pending';const ot=order.order_type||'walk_in';const sc=STATUS_COLOR[st]||P.textMuted;const isFinal=['completed','cancelled'].includes(st);
  const isCredit=order.is_credit_sale===1; const dueAmt=(order.grand_total||0)-(order.total_paid||0);const payC=isCredit?P.blue:(PAY_COLOR[order.payment_status]||P.textMuted);
  const tDone=localTasks.filter(t=>t.status==='completed').length;const tTotal=localTasks.length;
  const dC=delivInfo?(DELIV_COLOR[delivInfo.status]||P.textMuted):null;

  const acts=[];
  if(!isFinal){
    if(st==='pending'||st==='confirmed')acts.push({label:'Mark Preparing',next:'preparing',color:P.blue,icon:'construct-outline'});
    if(st==='preparing')acts.push({label:'Mark Ready',next:'ready',color:P.green,icon:'checkmark-circle-outline'});
    if(st==='ready'&&ot!=='delivery')acts.push({label:'Complete Order',next:'completed',color:P.pink,icon:'bag-check-outline'});
    if(order.payment_status==='pending'||order.payment_status==='partial')acts.push({label:'Collect Payment',next:'pay',color:P.blue,icon:'wallet-outline'});
    if(canManage)acts.push({label:'Cancel Order',next:'cancelled',color:P.red,icon:'close-circle-outline'});
  }

  const Btn=({label:lb,color:c,icon:ic,onPress:op,loading:ld,small})=>(
    <TouchableOpacity style={[dp.actionBtn,{backgroundColor:c},small&&{paddingVertical:6,paddingHorizontal:10}]} onPress={op} disabled={ld} activeOpacity={0.8}>
      {ld?<ActivityIndicator size="small" color="#fff"/>:<><Ionicons name={ic} size={small?12:14} color="#fff"/><Text style={[dp.actionBtnTxt,small&&{fontSize:11}]}>{lb}</Text></>}
    </TouchableOpacity>
  );

  return (
    <View style={dp.panel}>
      <View style={dp.hdr}>
        <View style={{flex:1}}>
          <Text style={dp.hdrTitle}>#{order.sale_number}</Text>
          <Text style={dp.hdrSub}>{order.customer_name||'Guest'} · {TYPE_LABEL[ot]||ot}</Text>
        </View>
        <TouchableOpacity onPress={onClose} style={dp.closeBtn}><Ionicons name="close" size={18} color={P.textSec}/></TouchableOpacity>
      </View>
      <ScrollView showsVerticalScrollIndicator={false} style={{flex:1}} contentContainerStyle={{paddingBottom:20}} keyboardShouldPersistTaps="handled">
        <View style={dp.badges}>
          <View style={[dp.badge,{backgroundColor:sc+'18'}]}><Text style={[dp.badgeTxt,{color:sc}]}>{(STATUS_LABEL[st]||st).toUpperCase()}</Text></View>
          <View style={[dp.badge,{backgroundColor:payC+'18'}]}><Text style={[dp.badgeTxt,{color:payC}]}>{isCredit?'CREDIT':order.payment_status==='pending'?'UNPAID':(order.payment_status||'pending').toUpperCase()}</Text></View>
          {ot==='pickup'&&order.pickup_status&&<View style={[dp.badge,{backgroundColor:(PICKUP_COLOR[order.pickup_status]||P.textMuted)+'18'}]}><Text style={[dp.badgeTxt,{color:PICKUP_COLOR[order.pickup_status]}]}>{PICKUP_LABEL[order.pickup_status]||order.pickup_status}</Text></View>}
        </View>
        <View style={dp.details}>
          <View style={dp.dRow}><Text style={dp.dLabel}>Total</Text><Text style={[dp.dVal,{color:P.green,fontWeight:'800'}]}>{fmt(order.grand_total)}</Text></View>
          {order.scheduled_date&&<View style={dp.dRow}><Text style={dp.dLabel}>Scheduled</Text><Text style={[dp.dVal,{color:P.pink}]}>{formatCardDT(order.scheduled_date,order.scheduled_time,tz)}</Text></View>}
          {order.delivery_address&&<View style={dp.dRow}><Text style={dp.dLabel}>Address</Text><Text style={dp.dVal}>{order.delivery_address}</Text></View>}
          {order.notes&&<View style={dp.dRow}><Text style={dp.dLabel}>Notes</Text><Text style={dp.dVal}>{order.notes}</Text></View>}
        </View>

        {/* Delivery section */}
        {ot==='delivery'&&<View style={[dp.block,{borderLeftColor:dC||P.textMuted}]}>
          <View style={{flexDirection:'row',alignItems:'center',gap:6,marginBottom:8}}><Ionicons name="bicycle" size={14} color={dC||P.textMuted}/><Text style={[dp.blockTitle,{color:dC||P.textMuted}]}>Delivery</Text>{delivLoading&&<ActivityIndicator size="small" color={P.textMuted}/>}</View>
          {delivInfo?<>
            <View style={[dp.badge,{backgroundColor:(dC||P.textMuted)+'18',alignSelf:'flex-start',marginBottom:6}]}><Text style={[dp.badgeTxt,{color:dC}]}>{DELIV_LABEL[delivInfo.status]||delivInfo.status}</Text></View>
            {delivInfo.partner_name&&<Text style={dp.delivMeta}>Partner: {delivInfo.partner_name}</Text>}
            {delivInfo.cod_amount>0&&<Text style={dp.delivMeta}>COD: {fmt(delivInfo.cod_amount)}</Text>}
            {canManage&&(!delivInfo.delivery_partner_id||delivInfo.status==='pending')&&!showPartnerPick&&<Btn label={delivInfo.delivery_partner_id?'Reassign':'Assign Partner'} color={P.blue} icon="person-add-outline" onPress={openPartnerPick} loading={delivActionLoading}/>}
            {showPartnerPick&&<View style={dp.picker}><Text style={dp.pickerTitle}>Assign Partner</Text>{partnersLoading?<ActivityIndicator color={P.pink}/>:partners.length===0?<Text style={dp.emptyTxt}>No partners</Text>:partners.map(p=><TouchableOpacity key={p.id} style={dp.pickerItem} onPress={()=>doPartnerAssign(p.id)}><Ionicons name="person" size={12} color={P.blue}/><Text style={dp.pickerName}>{p.name}</Text></TouchableOpacity>)}<TouchableOpacity onPress={()=>setShowPartnerPick(false)}><Text style={{color:P.textMuted,fontSize:11,marginTop:4}}>Cancel</Text></TouchableOpacity></View>}
            {canManage&&delivInfo.status!=='delivered'&&delivInfo.status!=='cancelled'&&!showPartnerPick&&!showCodForm&&!showFailForm&&<View style={{gap:5,marginTop:6}}>
              {delivInfo.status==='assigned'&&<Btn label="Picked Up" color={P.amber} icon="hand-left-outline" onPress={()=>doDelivAction('pickup')} loading={delivActionLoading} small/>}
              {delivInfo.status==='picked_up'&&<Btn label="In Transit" color={P.blue} icon="navigate-outline" onPress={()=>doDelivAction('in_transit')} loading={delivActionLoading} small/>}
              {(delivInfo.status==='picked_up'||delivInfo.status==='in_transit')&&<><Btn label="Delivered" color={P.green} icon="checkmark-circle-outline" onPress={()=>{delivInfo.cod_amount>0?setShowCodForm(true):doDelivAction('deliver');}} loading={delivActionLoading} small/><Btn label="Failed" color={P.red} icon="close-circle-outline" onPress={()=>setShowFailForm(true)} loading={delivActionLoading} small/></>}
              {delivInfo.status==='failed'&&<Btn label="Reattempt" color={P.amber} icon="refresh-outline" onPress={()=>doDelivAction('reattempt')} loading={delivActionLoading} small/>}
            </View>}
            {showCodForm&&<View style={dp.form}><Text style={dp.pickerTitle}>Collect COD</Text><TextInput style={dp.input} value={codAmount} onChangeText={setCodAmount} placeholder="Amount" placeholderTextColor={P.textMuted} keyboardType="numeric"/><View style={{flexDirection:'row',gap:5}}>{['cash','upi','card'].map(m=><TouchableOpacity key={m} style={[dp.methodChip,codMethod===m&&{backgroundColor:P.pink+'20',borderColor:P.pink}]} onPress={()=>setCodMethod(m)}><Text style={[dp.methodTxt,codMethod===m&&{color:P.pink}]}>{m.toUpperCase()}</Text></TouchableOpacity>)}</View><View style={{flexDirection:'row',gap:6,marginTop:4}}><Btn label="Confirm" color={P.green} icon="checkmark" onPress={handleDeliver} loading={delivActionLoading} small/><TouchableOpacity onPress={()=>setShowCodForm(false)}><Text style={{color:P.textMuted,fontSize:11}}>Cancel</Text></TouchableOpacity></View></View>}
            {showFailForm&&<View style={dp.form}><Text style={dp.pickerTitle}>Failure Reason</Text><TextInput style={[dp.input,{height:50}]} value={failReason} onChangeText={setFailReason} placeholder="Reason..." placeholderTextColor={P.textMuted} multiline/><View style={{flexDirection:'row',gap:6,marginTop:4}}><Btn label="Confirm" color={P.red} icon="close-circle" onPress={handleFail} loading={delivActionLoading} small/><TouchableOpacity onPress={()=>setShowFailForm(false)}><Text style={{color:P.textMuted,fontSize:11}}>Cancel</Text></TouchableOpacity></View></View>}
          </>:!delivLoading?<Text style={dp.emptyTxt}>No delivery record</Text>:null}
        </View>}

        {/* Tasks */}
        {tTotal>0&&<View style={dp.block}>
          <View style={{flexDirection:'row',alignItems:'center',gap:6,marginBottom:4}}><Ionicons name="hammer-outline" size={13} color={P.textSec}/><Text style={dp.blockTitle}>Production ({tDone}/{tTotal})</Text></View>
          <View style={dp.taskBar}><View style={[dp.taskFill,{width:tTotal>0?`${Math.round(tDone/tTotal*100)}%`:'0%'}]}/></View>
          {showAssign&&<View style={dp.picker}><Text style={dp.pickerTitle}>Assign Employee</Text>{empLoading?<ActivityIndicator color={P.pink}/>:employees.length===0?<Text style={dp.emptyTxt}>No employees</Text>:employees.map(e=><TouchableOpacity key={e.id} style={dp.pickerItem} onPress={()=>doTaskAssign(showAssign,e.id)}><Ionicons name="person" size={12} color={P.pink}/><Text style={dp.pickerName}>{e.name}</Text><Text style={{fontSize:9,color:P.textMuted}}>{e.role}</Text></TouchableOpacity>)}<TouchableOpacity onPress={()=>setShowAssign(null)}><Text style={{color:P.textMuted,fontSize:11,marginTop:4}}>Cancel</Text></TouchableOpacity></View>}
          {localTasks.map(task=>{const tc=TASK_COLOR(task.status);const tl=TASK_STATUS[task.status]||task.status;const isLd=!!taskLoading[task.id];const isDone=task.status==='completed'||task.status==='cancelled';
            return <View key={task.id} style={[dp.taskRow,{borderLeftColor:tc}]}><View style={{flex:1}}><Text style={dp.taskName} numberOfLines={1}>{Number(task.quantity||1)}× {task.product_name||task.item_product_name||'Item'}</Text><View style={{flexDirection:'row',alignItems:'center',gap:4,marginTop:2}}><View style={[dp.taskDot,{backgroundColor:tc}]}/><Text style={[dp.taskSt,{color:tc}]}>{tl}</Text>{task.assigned_to_name&&<Text style={{fontSize:9,color:P.textMuted}}>· {task.assigned_to_name}</Text>}</View></View>
              {!isDone&&!showAssign&&<View style={{gap:3}}>{canManage&&(task.status==='pending'||task.status==='assigned')&&<Btn label={task.assigned_to?'Reassign':'Assign'} color={P.pink} icon="person-add-outline" onPress={()=>openEmpPicker(task.id)} loading={isLd} small/>}{task.status==='assigned'&&<Btn label="Start" color={P.blue} icon="play-outline" onPress={()=>doTaskStart(task.id)} loading={isLd} small/>}{task.status==='in_progress'&&<Btn label={confirmTask===task.id?'Confirm?':'Done'} color={P.green} icon="checkmark" onPress={()=>doTaskComplete(task.id)} loading={isLd} small/>}</View>}
            </View>;
          })}
        </View>}

        
        {/* Payment Form */}
        {showPayForm && (
          <View style={[dp.block, { borderColor: P.blue }]}>
            <View style={{flexDirection:"row",justifyContent:"space-between",alignItems:"center"}}><Text style={dp.blockTitle}>Collect Payment</Text><Text style={{fontSize:11,fontWeight:"700",color:P.red}}>Due: {fmt(dueAmt)}</Text></View>
            <TextInput style={[dp.input, {marginTop: 6}]} value={payAmount} onChangeText={setPayAmount} placeholder="Amount" placeholderTextColor={P.textMuted} keyboardType="numeric"/>
            <View style={{flexDirection:'row',gap:5, marginTop: 6}}>
              {['cash','upi','card'].map(m=><TouchableOpacity key={m} style={[dp.methodChip,payMethod===m&&{backgroundColor:P.pink+'20',borderColor:P.pink}]} onPress={()=>setPayMethod(m)}><Text style={[dp.methodTxt,payMethod===m&&{color:P.pink}]}>{m.toUpperCase()}</Text></TouchableOpacity>)}
            </View>
            
            <View style={{flexDirection:'row',gap:6,marginTop:8}}>
              <Btn label="Submit Payment" color={P.green} icon="checkmark" onPress={handleCollectPayment} loading={payLoading} small/>
              <TouchableOpacity onPress={()=>setShowPayForm(false)} style={{justifyContent: 'center'}}><Text style={{color:P.textMuted,fontSize:11}}>Cancel</Text></TouchableOpacity>
            </View>
            <View style={{marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: P.border}}>
              <Text style={{fontSize: 10, fontWeight: '700', color: P.textSec, marginBottom: 6}}>Or resolve balance:</Text>
              <View style={{flexDirection:'row',gap:6}}>
                <Btn label="Write-off" color={P.amber} icon="cut-outline" onPress={()=>handleResolveBalance('write_off')} loading={payLoading} small/>
                <Btn label="Credit Sale" color={P.blue} icon="swap-horizontal-outline" onPress={()=>handleResolveBalance('credit')} loading={payLoading} small/>
              </View>
            </View>

          </View>
        )}

        {/* Status actions */}
        {!isFinal&&acts.length>0&&canManage&&<View style={dp.block}><Text style={[dp.blockTitle,{marginBottom:6}]}>Actions</Text>{acts.map(a=><View key={a.next} style={{marginBottom:5}}><Btn label={confirmStatus===a.next?'Tap to confirm':a.label} color={a.color} icon={a.icon} onPress={()=>confirmAction(a.next)} loading={actionLoading}/></View>)}</View>}
      </ScrollView>
      <View style={dp.footer}>
        {ot==='delivery'&&<TouchableOpacity style={dp.footerBtn} onPress={()=>generateDeliverySlip(order,localTasks)}><Ionicons name="print-outline" size={14} color={P.blue}/><Text style={[dp.footerBtnTxt,{color:P.blue}]}>Delivery Slip</Text></TouchableOpacity>}
        {ot==='pickup'&&<TouchableOpacity style={dp.footerBtn} onPress={()=>generatePickupSlip(order,localTasks)}><Ionicons name="print-outline" size={14} color={P.green}/><Text style={[dp.footerBtnTxt,{color:P.green}]}>Pickup Slip</Text></TouchableOpacity>}
        <TouchableOpacity style={[dp.footerBtn,{backgroundColor:P.pinkGlow}]} onPress={()=>{onClose();setTimeout(()=>navigation.navigate('SaleDetail',{saleId:order.id}),200);}}><Ionicons name="document-text-outline" size={14} color={P.pink}/><Text style={[dp.footerBtnTxt,{color:P.pink}]}>Full Details</Text><Ionicons name="chevron-forward" size={12} color={P.pink}/></TouchableOpacity>
      </View>
    </View>
  );
}

const dp = StyleSheet.create({
  panel:{flex:1,backgroundColor:P.surface},
  hdr:{flexDirection:'row',alignItems:'center',padding:14,borderBottomWidth:1,borderBottomColor:P.border},
  hdrTitle:{fontSize:17,fontWeight:'800',color:P.text},hdrSub:{fontSize:11,color:P.textSec,marginTop:2},
  closeBtn:{width:30,height:30,borderRadius:15,backgroundColor:P.surfaceAlt,alignItems:'center',justifyContent:'center'},
  badges:{flexDirection:'row',gap:5,padding:14,paddingBottom:6,flexWrap:'wrap'},
  badge:{paddingHorizontal:7,paddingVertical:3,borderRadius:5},badgeTxt:{fontSize:9,fontWeight:'800'},
  details:{paddingHorizontal:14,paddingBottom:10,gap:6},dRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start'},
  dLabel:{fontSize:11,color:P.textMuted,fontWeight:'700'},dVal:{fontSize:12,color:P.text,fontWeight:'600',flex:1,textAlign:'right',marginLeft:10},
  block:{marginHorizontal:14,marginBottom:10,padding:10,backgroundColor:P.surfaceAlt,borderRadius:10,borderWidth:1,borderColor:P.border,borderLeftWidth:3},
  blockTitle:{fontSize:12,fontWeight:'700',color:P.textSec},
  taskBar:{height:3,backgroundColor:P.border,borderRadius:2,marginBottom:8},taskFill:{height:3,backgroundColor:P.green,borderRadius:2},
  taskRow:{flexDirection:'row',alignItems:'center',gap:6,paddingVertical:6,borderLeftWidth:3,paddingLeft:8,marginBottom:3,backgroundColor:P.surface,borderRadius:6},
  taskName:{fontSize:11,fontWeight:'700',color:P.text},taskDot:{width:5,height:5,borderRadius:3},taskSt:{fontSize:9,fontWeight:'700'},
  actionBtn:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:5,paddingVertical:9,paddingHorizontal:12,borderRadius:8},
  actionBtnTxt:{color:'#fff',fontWeight:'700',fontSize:12},
  picker:{backgroundColor:P.surfaceAlt,borderRadius:8,padding:8,marginBottom:6,borderWidth:1,borderColor:P.border},
  pickerTitle:{fontSize:11,fontWeight:'700',color:P.text,marginBottom:6},
  pickerItem:{flexDirection:'row',alignItems:'center',gap:6,paddingVertical:6,borderBottomWidth:1,borderBottomColor:P.border},
  pickerName:{fontSize:12,fontWeight:'600',color:P.text,flex:1},
  form:{backgroundColor:P.surfaceAlt,borderRadius:8,padding:8,marginTop:6,gap:6,borderWidth:1,borderColor:P.border},
  input:{backgroundColor:P.surface,borderRadius:6,borderWidth:1,borderColor:P.border,paddingHorizontal:10,paddingVertical:6,color:P.text,fontSize:12},
  methodChip:{paddingHorizontal:10,paddingVertical:4,borderRadius:5,borderWidth:1,borderColor:P.border},
  methodTxt:{fontSize:10,fontWeight:'700',color:P.textSec},
  delivMeta:{fontSize:11,color:P.textSec,marginBottom:3},
  emptyTxt:{fontSize:11,color:P.textMuted,fontStyle:'italic'},
  footer:{paddingHorizontal:14,paddingVertical:10,borderTopWidth:1,borderTopColor:P.border,gap:5},
  footerBtn:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:5,paddingVertical:8,borderRadius:8,borderWidth:1,borderColor:P.border,backgroundColor:P.surfaceAlt},
  footerBtnTxt:{fontSize:12,fontWeight:'700'},
});
/* ═══ MAIN COMPONENT ══════════════════════════════════════════ */
export default function DashboardScreenV2({ navigation }) {
  const { width } = useWindowDimensions();
  const { user, activeLocation, settings } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const role = user?.role;
  const isOwner = role==='owner';
  const isOwnerOrManager = role==='owner'||role==='manager';
  const isEmployee = role==='employee';
  const isDeliveryPartner = role==='delivery_partner';
  const isStaff = role==='owner'||role==='manager'||role==='employee';
  const isWide = width >= 900;
  const isDesktop = width >= 1100;

  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [locations, setLocations] = useState([]);
  const [locationScope, setLocationScope] = useState(null);
  const [dateScope, setDateScope] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [sales, setSales] = useState([]);
  const [taskRows, setTaskRows] = useState([]);
  const [staffPulse, setStaffPulse] = useState([]);
  const [registers, setRegisters] = useState([]);
  const [reportKPIs, setReportKPIs] = useState(null);
  const [myTasks, setMyTasks] = useState([]);
  const [myDeliveries, setMyDeliveries] = useState([]);
  const [taskActionLoading, setTaskActionLoading] = useState({});
  const [fabVisible, setFabVisible] = useState(false);

  const showPanel = selectedOrder !== null;

  /* ─── DATA FETCH ─────────────────────────────────────────── */
  const fetchDashboard = useCallback(async()=>{
    try {
      if (isDeliveryPartner) {
        const [delivRes,unsettledRes]=await Promise.all([api.getDeliveries({status:'active'}).catch(()=>({data:[]})),api.getUnsettledDeliveries({}).catch(()=>({data:{deliveries:[],total_unsettled:0}}))]);
        setMyDeliveries(delivRes?.data||[]);const ud=unsettledRes?.data||{};setReportKPIs({unsettledTotal:Number(ud.total_unsettled||0),unsettledCount:(ud.deliveries||[]).length});setLoading(false);setRefreshing(false);return;
      }
      if (isEmployee) {
        const [myTasksRes,allTasksRes]=await Promise.all([api.getMyTasks().catch(()=>({data:[]})),api.getProductionTasks({}).catch(()=>({data:[]}))]);
        setMyTasks(myTasksRes?.data||[]);setTaskRows(allTasksRes?.data||[]);setLoading(false);setRefreshing(false);return;
      }
      const locationRes=await api.getLocations();const locationList=locationRes?.data?.locations||locationRes?.data||[];setLocations(Array.isArray(locationList)?locationList:[]);
      let locationId;if(locationScope==='all'&&isOwner)locationId=null;else if(locationScope!=null)locationId=locationScope;else locationId=activeLocation?.id||locationList?.[0]?.id||null;
      const filters=locationId?{location_id:locationId}:{};
      if(dateScope){const pad=n=>String(n).padStart(2,'0');filters.filter_date=`${dateScope.getFullYear()}-${pad(dateScope.getMonth()+1)}-${pad(dateScope.getDate())}`;}
      const reqs=[api.getSales({...filters,limit:500}),api.getProductionTasks({})];
      if(isOwnerOrManager){reqs.push(api.getStaffToday(filters));reqs.push(api.getReportsDashboard(filters).catch(()=>({data:null})));}
      else if(isStaff)reqs.push(api.getMyTasks().catch(()=>({data:[]})));
      const results=await Promise.all(reqs);const salesRows=results[0]?.data?.sales||results[0]?.data||[];const tasks=results[1]?.data||[];
      setSales(Array.isArray(salesRows)?salesRows.filter(x=>['delivery','pickup','walk_in'].includes(x.order_type)):[]);
      setTaskRows(Array.isArray(tasks)?tasks:[]);
      if(isOwnerOrManager){
        const staffRes=results[2];const reportsRes=results[3];const present=staffRes?.data?.present||[];const absent=staffRes?.data?.absent||[];
        const presentByUser=new Map();
        for(const sp of present){let pulse='active',pulseLabel='Active';const isActive=typeof sp.active_session==='boolean'?sp.active_session:!sp.clock_out;if(isActive&&(Number(sp.outdoor_hours||0)>0||sp.status==='half_day')){pulse='busy';pulseLabel='Busy';}else if(!isActive){pulse='off';pulseLabel='Off-shift';}
          const entry={id:`p-${sp.user_id||sp.id}`,rawUserId:sp.user_id||sp.id,name:sp.user_name,roleLabel:(sp.user_role||'').replace('_',' '),pulse,pulseLabel};const existing=presentByUser.get(entry.rawUserId);if(!existing||existing.pulse==='off'&&entry.pulse!=='off')presentByUser.set(entry.rawUserId,entry);}
        const normalizedAbsent=absent.map(x=>({id:`a-${x.id}`,name:x.name,roleLabel:(x.role||'').replace('_',' '),pulse:'off',pulseLabel:'Off-shift'}));
        setStaffPulse([...presentByUser.values(),...normalizedAbsent].slice(0,10));setReportKPIs(reportsRes?.data||null);
      }
      if(locationList.length>0){const regCalls=await Promise.all(locationList.map(async loc=>{try{const reg=await api.getRegisterStatus(loc.id);return{locationId:loc.id,locationName:loc.name,isOpen:reg?.isOpen===true,register:reg?.data||null};}catch{return{locationId:loc.id,locationName:loc.name,isOpen:false,register:null};}}));setRegisters(regCalls);}else setRegisters([]);
    }catch(err){Alert.alert('Dashboard',err?.message||'Failed to load.');}finally{setLoading(false);setRefreshing(false);}
  },[activeLocation?.id,isOwner,isOwnerOrManager,isStaff,isEmployee,isDeliveryPartner,locationScope,dateScope,role]);

  useEffect(()=>{if(locationScope!=null)return;if(activeLocation?.id){setLocationScope(activeLocation.id);return;}if(locations.length>0)setLocationScope(locations[0].id);},[locationScope,activeLocation?.id,locations]);
  useFocusEffect(useCallback(()=>{setLoading(true);fetchDashboard();},[fetchDashboard]));
  const onRefresh=useCallback(()=>{setRefreshing(true);fetchDashboard();},[fetchDashboard]);

  const tasksBySaleId=useMemo(()=>{const m=new Map();for(const t of taskRows){const a=m.get(t.sale_id)||[];a.push(t);m.set(t.sale_id,a);}return m;},[taskRows]);

  const activeOrderModalData = useMemo(() => {
    if (!selectedOrder) return null;
    const freshOrder = sales.find(s => s.id === selectedOrder.order.id) || selectedOrder.order;
    const freshTasks = tasksBySaleId.get(selectedOrder.order.id) || selectedOrder.tasks;
    return { order: freshOrder, tasks: freshTasks };
  }, [selectedOrder, sales, tasksBySaleId]);

  const ordersByTypeAndStatus=useMemo(()=>{
    const base={delivery:{pending:[],preparing:[],ready:[],in_transit:[]},pickup:{pending:[],preparing:[],ready:[]},walk_in:{pending:[],preparing:[],ready:[]}};
    for(const order of sales){
      if(!['delivery','pickup','walk_in'].includes(order.order_type)||order.status==='cancelled'||order.status==='draft')continue;
      if(order.order_type==='delivery'){const ds=order.delivery_status??order.delivery?.status;if(['picked_up','in_transit'].includes(ds)){base.delivery.in_transit.push(order);continue;}}
      if(order.status==='completed')continue;
      const np=normalizePhase(order.status);const bucket=np==='ready'?'ready':np==='preparing'?'preparing':'pending';
      base[order.order_type][bucket].push(order);
    }return base;
  },[sales]);

  const kpis=useMemo(()=>{
    let active=0,overdue=0,inTransit=0;
    for(const type of ['delivery','pickup','walk_in']){const g=ordersByTypeAndStatus[type]||{};for(const k of Object.keys(g)){active+=g[k].length;g[k].forEach(o=>{if(getOrderSla(o,timezone)==='overdue')overdue++;});}if(type==='delivery')inTransit+=(g.in_transit||[]).length;}
    return {active,overdue,inTransit,revenue:reportKPIs?.today?.revenue||0};
  },[ordersByTypeAndStatus,timezone,reportKPIs]);

  const advanceTask=useCallback(async(task)=>{if(!task?.id||task.status==='completed'||task.status==='cancelled')return;setTaskActionLoading(p=>({...p,[task.id]:true}));try{if(task.status==='pending')await api.pickTask(task.id);else if(task.status==='assigned')await api.startTask(task.id);else if(task.status==='in_progress')await api.completeTask(task.id);await fetchDashboard();}catch(e){const msg=e?.message||"Failed";Platform.OS==="web"?window.alert(msg):Alert.alert("Error",msg);}finally{setTaskActionLoading(p=>({...p,[task.id]:false}));};},[fetchDashboard]);

  const handleNavigateToQueue=useCallback((orderType,status)=>{navigation.navigate('ProductionQueue',{applyId:Date.now(),initialViewMode:'orders',initialOrderType:orderType,initialStatus:status||'',initialLocationId:locationScope==='all'?null:(locationScope||activeLocation?.id||null),initialShowFilters:true});},[navigation,activeLocation?.id,locationScope]);

  /* ─── Employee view ──────────────────────────────────────── */
  if(isEmployee){
    const activeTasks=myTasks.filter(t=>t.status!=='completed'&&t.status!=='cancelled');
    const doneTasks=myTasks.filter(t=>t.status==='completed');
    return <View style={ms.root}><ScrollView style={ms.container} contentContainerStyle={ms.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P.pink}/>}>
      <View style={ms.heroLight}><Text style={ms.heroEye}>MY TASKS</Text><Text style={ms.heroTitle}>Hey, {(user?.name||'Team').split(' ')[0]}</Text></View>
      <View style={ms.kpiRow}><KpiChip icon="hourglass-outline" label="Assigned" value={myTasks.filter(t=>t.status==='assigned').length} color={P.amber} bg={P.amberLight}/><KpiChip icon="construct-outline" label="Active" value={myTasks.filter(t=>t.status==='in_progress').length} color={P.blue} bg={P.blueLight}/><KpiChip icon="checkmark-done-outline" label="Done" value={doneTasks.length} color={P.green} bg={P.greenLight}/></View>
      {loading?<ActivityIndicator color={P.pink} style={{marginTop:40}}/>:activeTasks.length===0?<View style={ms.emptyCard}><Ionicons name="checkmark-circle-outline" size={36} color={P.green}/><Text style={ms.emptyTitle}>All caught up!</Text></View>:
      activeTasks.map(task=>{const tc=TASK_COLOR(task.status);const isLd=!!taskActionLoading[task.id];return <View key={task.id} style={[ms.taskCard,{borderLeftColor:tc}]}><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><Text style={ms.taskName} numberOfLines={1}>{Number(task.quantity||1)}× {task.product_name||task.item_product_name||'Task'}</Text><View style={[cs.badge,{backgroundColor:tc+'18'}]}><Text style={[cs.badgeTxt,{color:tc}]}>{TASK_STATUS[task.status]}</Text></View></View>{task.sale_number&&<Text style={ms.taskMeta}>Order #{task.sale_number}</Text>}<View style={{flexDirection:'row',justifyContent:'flex-end',marginTop:6,gap:6}}>{task.status==='assigned'&&<TouchableOpacity style={[dp.actionBtn,{backgroundColor:P.blue}]} onPress={()=>advanceTask(task)} disabled={isLd}>{isLd?<ActivityIndicator size="small" color="#fff"/>:<Text style={dp.actionBtnTxt}>Start →</Text>}</TouchableOpacity>}{task.status==='in_progress'&&<TouchableOpacity style={[dp.actionBtn,{backgroundColor:P.green}]} onPress={()=>advanceTask(task)} disabled={isLd}>{isLd?<ActivityIndicator size="small" color="#fff"/>:<Text style={dp.actionBtnTxt}>Complete ✓</Text>}</TouchableOpacity>}</View></View>;})}
    </ScrollView></View>;
  }

  /* ─── Delivery Partner view ──────────────────────────────── */
  if(isDeliveryPartner){
    return <View style={ms.root}><ScrollView style={ms.container} contentContainerStyle={ms.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P.pink}/>}>
      <View style={ms.heroLight}><Text style={ms.heroEye}>DELIVERIES</Text><Text style={ms.heroTitle}>Hey, {(user?.name||'Team').split(' ')[0]}</Text></View>
      <View style={ms.kpiRow}><KpiChip icon="bicycle-outline" label="Active" value={myDeliveries.filter(d=>['assigned','picked_up','in_transit'].includes(d.status)).length} color={P.blue} bg={P.blueLight}/><KpiChip icon="time-outline" label="Pending" value={myDeliveries.filter(d=>d.status==='pending').length} color={P.amber} bg={P.amberLight}/><KpiChip icon="wallet-outline" label="Unsettled" value={`₹${reportKPIs?.unsettledTotal||0}`} color={P.green} bg={P.greenLight}/></View>
      {loading?<ActivityIndicator color={P.pink} style={{marginTop:40}}/>:myDeliveries.length===0?<View style={ms.emptyCard}><Ionicons name="checkmark-circle-outline" size={36} color={P.green}/><Text style={ms.emptyTitle}>All clear!</Text></View>:
      myDeliveries.map(d=>{const sc=DELIV_COLOR[d.status]||P.textMuted;return <TouchableOpacity key={d.id} style={[ms.taskCard,{borderLeftColor:sc}]} onPress={()=>navigation.navigate('DeliveryDetail',{deliveryId:d.id})} activeOpacity={0.8}><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><Text style={ms.taskName}>#{d.sale_number}</Text><View style={[cs.badge,{backgroundColor:sc+'18'}]}><Text style={[cs.badgeTxt,{color:sc}]}>{(DELIV_LABEL[d.status]||d.status).toUpperCase()}</Text></View></View><Text style={ms.taskMeta} numberOfLines={1}><Ionicons name="location-outline" size={11} color={P.textSec}/> {d.delivery_address||'No address'}</Text>{Number(d.cod_amount)>0&&<View style={[cs.badge,{backgroundColor:P.amberLight,alignSelf:'flex-start',marginTop:4}]}><Text style={[cs.badgeTxt,{color:P.amber}]}>COD ₹{Number(d.cod_amount).toFixed(0)}</Text></View>}</TouchableOpacity>;})}
    </ScrollView></View>;
  }

  /* ─── Owner / Manager view ───────────────────────────────── */
  return (
    <View style={ms.root}>
      <View style={{flex:1,flexDirection:isDesktop&&showPanel?'row':'column'}}>
        <ScrollView style={ms.container} contentContainerStyle={ms.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P.pink}/>}>
          {/* Scope bar */}
          {(locations.length>0||isOwnerOrManager)&&<View style={ms.scopeBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:5,paddingRight:8}}>
              {isOwner&&<TouchableOpacity style={[ms.scopeChip,locationScope==='all'&&ms.scopeChipActive]} onPress={()=>setLocationScope('all')}><Text style={[ms.scopeChipTxt,locationScope==='all'&&ms.scopeChipTxtActive]}>All</Text></TouchableOpacity>}
              {locations.map(loc=><TouchableOpacity key={loc.id} style={[ms.scopeChip,locationScope===loc.id&&ms.scopeChipActive]} onPress={()=>setLocationScope(loc.id)}><Text style={[ms.scopeChipTxt,locationScope===loc.id&&ms.scopeChipTxtActive]}>{loc.name}</Text></TouchableOpacity>)}
            </ScrollView>
            <TouchableOpacity style={ms.dateBtn} onPress={()=>setShowDatePicker(true)}>
              <Ionicons name="calendar-outline" size={13} color={P.pink}/>
              <Text style={ms.dateBtnTxt}>{dateScope?dateScope.toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'All'}</Text>
              {dateScope&&<TouchableOpacity onPress={()=>setDateScope(null)} hitSlop={{top:10,bottom:10,left:10,right:10}}><Ionicons name="close-circle" size={13} color={P.pink}/></TouchableOpacity>}
            </TouchableOpacity>
          </View>}

          {loading?<View style={{alignItems:'center',paddingVertical:50}}><ActivityIndicator color={P.pink} size="large"/><Text style={{color:P.textSec,marginTop:10}}>Loading...</Text></View>:<>
            {/* KPI strip */}
            <View style={ms.kpiRow}>
              <KpiChip icon="layers-outline" label="Active" value={kpis.active} color={P.blue} bg={P.blueLight}/>
              <KpiChip icon="alert-circle-outline" label="Overdue" value={kpis.overdue} color={P.red} bg={P.redLight}/>
              <KpiChip icon="navigate-outline" label="In Transit" value={kpis.inTransit} color={P.pink} bg={P.pinkLight}/>
              {isOwner&&<KpiChip icon="trending-up-outline" label="Revenue" value={fmt(kpis.revenue)} color={P.green} bg={P.greenLight}/>}
            </View>

            {/* ALL order type sections visible at once */}
            {['delivery','pickup','walk_in'].map(type=>(
              <TypeSection key={type} orderType={type} laneBuckets={ordersByTypeAndStatus[type]||{}} tasksBySaleId={tasksBySaleId} timezone={timezone} isWide={isWide} onPressOrder={(o)=>setSelectedOrder({order:o,tasks:tasksBySaleId.get(o.id)||[]})} onViewAll={(ot,st)=>handleNavigateToQueue(ot,st)}/>
            ))}

            {/* Staff pulse */}
            {staffPulse.length>0&&<View style={ms.widget}><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:8}}><Text style={ms.widgetTitle}>Staff</Text><TouchableOpacity onPress={()=>isOwnerOrManager&&navigation.navigate('More',{screen:'Staff',initial:false})}><Ionicons name="open-outline" size={13} color={P.textMuted}/></TouchableOpacity></View>
              {staffPulse.map(x=>{const tone=x.pulse==='active'?P.green:x.pulse==='busy'?P.amber:P.textMuted;return <View key={x.id} style={[ms.staffRow,{borderLeftColor:tone}]}><View style={[ms.staffDot,{backgroundColor:tone}]}/><View style={{flex:1}}><Text style={ms.staffName}>{x.name}</Text><Text style={ms.staffMeta}>{x.roleLabel}</Text></View><View style={[cs.badge,{backgroundColor:tone+'18'}]}><Text style={[cs.badgeTxt,{color:tone}]}>{x.pulseLabel}</Text></View></View>;})}
            </View>}

            {/* Revenue & registers */}
            {isOwner&&reportKPIs&&<View style={ms.widget}><Text style={[ms.widgetTitle,{marginBottom:8}]}>Revenue</Text><View style={{alignItems:'center',marginBottom:8}}><Text style={{fontSize:10,color:P.textMuted,fontWeight:'700'}}>Today</Text><Text style={{fontSize:20,color:P.green,fontWeight:'800',marginTop:2}}>{fmt(reportKPIs?.today?.revenue)}</Text></View><View style={{flexDirection:'row',justifyContent:'space-around'}}><View style={{alignItems:'center'}}><Text style={{fontSize:10,color:P.textMuted}}>Yesterday</Text><Text style={{fontSize:13,color:P.pink,fontWeight:'700',marginTop:2}}>{fmt(reportKPIs?.yesterday?.revenue)}</Text></View><View style={{alignItems:'center'}}><Text style={{fontSize:10,color:P.textMuted}}>Week</Text><Text style={{fontSize:13,color:P.blue,fontWeight:'700',marginTop:2}}>{fmt(reportKPIs?.week?.revenue)}</Text></View></View></View>}
            {isOwner&&registers.length>0&&<View style={{gap:6,marginBottom:12}}><Text style={ms.widgetTitle}>Registers</Text>{registers.map(r=>{const tone=r.isOpen?P.green:P.red;return <TouchableOpacity key={r.locationId} style={[ms.regCard,{borderLeftColor:tone}]} onPress={()=>navigation.navigate('POS',{screen:'CashRegister',params:{locationId:r.locationId}})}><View style={{flexDirection:'row',justifyContent:'space-between'}}><View><Text style={ms.regTitle}>{r.locationName}</Text><Text style={[ms.regStatus,{color:tone}]}>{r.isOpen?'● OPEN':'● CLOSED'}</Text></View><View style={{alignItems:'flex-end'}}><Text style={{fontSize:9,color:P.textMuted}}>Expected</Text><Text style={{fontSize:12,fontWeight:'800',color:P.text}}>{fmt(r.register?.expected_cash||0)}</Text></View></View></TouchableOpacity>;})}</View>}
          </>}
        </ScrollView>

        {/* Side panel (desktop) */}
        {showPanel&&isDesktop&&<View style={ms.sidePanel}><DetailPanel order={activeOrderModalData.order} tasks={activeOrderModalData.tasks} onClose={()=>setSelectedOrder(null)} onRefresh={fetchDashboard} navigation={navigation} canManage={isOwnerOrManager} tz={timezone}/></View>}
      </View>

      {/* Bottom sheet (mobile) */}
      <Modal visible={showPanel&&!isDesktop} transparent animationType="slide" onRequestClose={()=>setSelectedOrder(null)}>
        <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}>
          <TouchableOpacity style={ms.sheetBg} activeOpacity={1} onPress={()=>setSelectedOrder(null)}>
            <TouchableOpacity activeOpacity={1} style={ms.sheetWrap}><View style={ms.sheetHandle}/>{activeOrderModalData&&<DetailPanel order={activeOrderModalData.order} tasks={activeOrderModalData.tasks} onClose={()=>setSelectedOrder(null)} onRefresh={fetchDashboard} navigation={navigation} canManage={isOwnerOrManager} tz={timezone}/>}</TouchableOpacity>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* FAB (consistent with V1 pattern, not a dock) */}
      {!loading&&isOwnerOrManager&&!showPanel&&<>
        <TouchableOpacity style={ms.fab} onPress={()=>setFabVisible(true)} activeOpacity={0.85}><Ionicons name="add" size={26} color="#fff"/></TouchableOpacity>
        <Modal visible={fabVisible} transparent animationType="fade" onRequestClose={()=>setFabVisible(false)}>
          <TouchableOpacity style={ms.fabBg} activeOpacity={1} onPress={()=>setFabVisible(false)}>
            <View style={ms.fabCard}>
              <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:12}}><Text style={{fontSize:15,fontWeight:'800',color:P.text}}>Quick Actions</Text><TouchableOpacity onPress={()=>setFabVisible(false)}><Ionicons name="close" size={18} color={P.textMuted}/></TouchableOpacity></View>
              {[{label:'Quick Sale',icon:'flash-outline',color:P.green,screen:'QuickCheckout',bg:P.greenLight},{label:'POS Terminal',icon:'cart-outline',color:P.blue,screen:'POSHome',bg:P.blueLight},{label:'Cash Register',icon:'wallet-outline',color:P.amber,screen:'CashRegister',bg:P.amberLight}].map(a=>
                <TouchableOpacity key={a.label} style={[ms.fabItem,{backgroundColor:a.bg}]} onPress={()=>{setFabVisible(false);navigation.navigate('POS',{screen:a.screen,params:{locationId:activeLocation?.id}});}}><View style={[ms.fabIcon,{backgroundColor:a.color}]}><Ionicons name={a.icon} size={16} color="#fff"/></View><View style={{flex:1}}><Text style={[ms.fabItemLabel,{color:a.color}]}>{a.label}</Text></View><Ionicons name="chevron-forward" size={14} color={a.color}/></TouchableOpacity>
              )}
            </View>
          </TouchableOpacity>
        </Modal>
      </>}
      <DateTimePickerModal visible={showDatePicker} mode="date" value={dateScope||new Date()} onConfirm={d=>{setDateScope(d);setShowDatePicker(false);}} onCancel={()=>setShowDatePicker(false)} title="Select Date"/>
    </View>
  );
}
/* ─── STYLES ──────────────────────────────────────────────── */
const ms = StyleSheet.create({
  root:{flex:1,backgroundColor:P.bg},
  container:{flex:1},content:{paddingHorizontal:14,paddingBottom:20,paddingTop:10},
  heroLight:{marginBottom:12},heroEye:{fontSize:10,fontWeight:'800',color:P.pink,letterSpacing:2},heroTitle:{fontSize:22,fontWeight:'800',color:P.text,marginTop:2},
  kpiRow:{flexDirection:'row',gap:8,marginBottom:14},
  scopeBar:{flexDirection:'row',alignItems:'center',gap:8,marginBottom:12,paddingRight:4},
  scopeChip:{paddingHorizontal:12,paddingVertical:7,borderRadius:99,backgroundColor:P.surface,borderWidth:1,borderColor:P.border},
  scopeChipActive:{backgroundColor:P.pink,borderColor:P.pink},
  scopeChipTxt:{fontSize:12,fontWeight:'700',color:P.textSec},
  scopeChipTxtActive:{color:'#fff'},
  dateBtn:{flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:10,paddingVertical:7,borderRadius:99,backgroundColor:P.pinkGlow,borderWidth:1,borderColor:P.pinkLight},
  dateBtnTxt:{fontSize:12,fontWeight:'700',color:P.pink},

  widget:{backgroundColor:P.surface,borderRadius:14,borderWidth:1,borderColor:P.border,padding:14,marginBottom:12,...Shadows.sm},
  widgetTitle:{fontSize:12,fontWeight:'800',color:P.text,textTransform:'uppercase',letterSpacing:0.5},
  staffRow:{flexDirection:'row',alignItems:'center',gap:8,paddingVertical:6,borderLeftWidth:3,paddingLeft:8,marginBottom:3},
  staffDot:{width:6,height:6,borderRadius:3},staffName:{fontSize:12,fontWeight:'700',color:P.text},staffMeta:{fontSize:10,color:P.textMuted},

  regCard:{backgroundColor:P.surface,borderRadius:10,borderWidth:1,borderColor:P.border,padding:10,borderLeftWidth:4,...Shadows.sm},
  regTitle:{fontSize:12,fontWeight:'700',color:P.text},regStatus:{fontSize:10,fontWeight:'800',marginTop:2},

  sidePanel:{width:380,borderLeftWidth:1,borderLeftColor:P.border,backgroundColor:P.surface},
  sheetBg:{flex:1,backgroundColor:'rgba(0,0,0,0.35)',justifyContent:'flex-end'},
  sheetWrap:{backgroundColor:P.surface,borderTopLeftRadius:18,borderTopRightRadius:18,maxHeight:'88%',minHeight:300},
  sheetHandle:{width:36,height:4,borderRadius:2,backgroundColor:P.border,alignSelf:'center',marginTop:10},

  fab:{position:'absolute',bottom:20,right:20,width:52,height:52,borderRadius:26,backgroundColor:P.pink,alignItems:'center',justifyContent:'center',...Shadows.glow(P.pink)},
  fabBg:{flex:1,backgroundColor:'rgba(0,0,0,0.35)',justifyContent:'center',alignItems:'center',padding:30},
  fabCard:{backgroundColor:P.surface,borderRadius:18,padding:20,width:'100%',maxWidth:360,...Shadows.lg},
  fabItem:{flexDirection:'row',alignItems:'center',gap:10,padding:12,borderRadius:12,marginBottom:6},
  fabIcon:{width:32,height:32,borderRadius:8,alignItems:'center',justifyContent:'center'},
  fabItemLabel:{fontSize:14,fontWeight:'700'},

  emptyCard:{alignItems:'center',justifyContent:'center',padding:40,gap:8,backgroundColor:P.surface,borderRadius:14,borderWidth:1,borderColor:P.border,marginTop:12},
  emptyTitle:{fontSize:15,fontWeight:'700',color:P.text},
  taskCard:{backgroundColor:P.surface,borderRadius:10,padding:12,borderLeftWidth:4,borderWidth:1,borderColor:P.border,marginBottom:6,...Shadows.sm},
  taskName:{fontSize:13,fontWeight:'700',color:P.text,flex:1,marginRight:8},taskMeta:{fontSize:11,color:P.textSec,marginTop:3},
});
