import React from 'react';
import { Keyboard, Pressable, StyleSheet } from 'react-native';

export default function DismissKeyboard({ children }) {
  return (
    <Pressable style={styles.flex} onPress={Keyboard.dismiss} accessible={false}>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
