import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY } from '../../constants/orderDisplay';

/**
 * A plain "who does this?" list. Deliberately generic — used for riders
 * (Task 14) and for florists (Task 15) so the two never drift into different
 * interactions for the same kind of decision.
 */
export default function AssignPickerModal({ visible, title, notice, people, loading, onPick, onClose, footer }) {
  const list = Array.isArray(people) ? people : [];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{title}</Text>
          {/* Only rendered when the caller has something to say about WHY this
              list looks the way it does — e.g. it is not the list you would
              normally get. Never shown on a normal result. */}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {loading ? (
            <ActivityIndicator color={Colors.primary} style={{ paddingVertical: 24 }} />
          ) : list.length === 0 ? (
            <Text style={styles.empty}>Nobody is available right now.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 320 }}>
              {list.map((p) => (
                <TouchableOpacity key={p.id} style={styles.row} onPress={() => onPick(p)} activeOpacity={0.7}>
                  <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
                  {p.meta ? <Text style={styles.meta}>{p.meta}</Text> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
          {footer}
          <TouchableOpacity style={styles.cancel} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000055', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, maxWidth: 420, width: '100%', alignSelf: 'center' },
  title: { fontSize: 17, fontWeight: '800', color: Colors.text, fontFamily: FONT_FAMILY, marginBottom: 10 },
  notice: { fontSize: 13, lineHeight: 18, color: '#92400E', backgroundColor: Colors.warningLight, fontFamily: FONT_FAMILY, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB', marginBottom: 8 },
  name: { fontSize: 16, fontWeight: '700', color: Colors.text, fontFamily: FONT_FAMILY, flexShrink: 1 },
  meta: { fontSize: 13, color: Colors.textLight, fontFamily: FONT_FAMILY, marginLeft: 10 },
  empty: { fontSize: 14, color: Colors.textLight, fontFamily: FONT_FAMILY, paddingVertical: 20, textAlign: 'center' },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  cancelText: { fontSize: 15, fontWeight: '700', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
});
